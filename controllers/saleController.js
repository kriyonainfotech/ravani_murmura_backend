const Sale = require('../models/Sale');
const ReadyStock = require('../models/ReadyStock');
const ShopStock = require('../models/ShopStock');
const PackagingDispatch = require('../models/PackagingDispatch');
const ProductSetting = require('../models/ProductSetting');
const { buildSplit, recordLoss } = require('../utils/lossLedger');
const Payment = require('../models/Payment');
const { recordSaleAtBilling, round2, statusFor, PAYMENT_MODES, ACCOUNTS, nextPaymentId } = require('../utils/finance');

// Helper to generate next Sale ID (e.g., SALE-0001)
const generateSaleId = async () => {
  const lastSale = await Sale.findOne().sort({ createdAt: -1 });
  let nextNum = 1;
  if (lastSale && lastSale.saleId && lastSale.saleId.startsWith('SALE-')) {
    const numPart = parseInt(lastSale.saleId.replace('SALE-', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }
  return `SALE-${nextNum.toString().padStart(4, '0')}`;
};

// 1. Get Available Stock for Sale (FIFO sorted)
exports.getAvailableStockForSale = async (req, res) => {
  try {
    const { sellFrom, storeName } = req.query; // 'Packaging Godown' or 'Shop'

    if (sellFrom === 'Packaging Godown') {
      const readyStocks = await ReadyStock.find({ availablePackets: { $gt: 0 } })
        .sort({ productionDate: 1 }); // FIFO (oldest first)
      return res.json(readyStocks);
    } else {
      // Default to Shop
      let shopQuery = { availablePackets: { $gt: 0 } };
      if (storeName && storeName !== 'All') {
        shopQuery.storeName = new RegExp('^' + storeName.trim() + '$', 'i');
      }
      const shopStocks = await ShopStock.find(shopQuery)
        .populate('dispatchId')
        .sort({ receivedDate: -1 });
      return res.json(shopStocks);
    }
  } catch (error) {
    res.status(500).json({ message: 'Error fetching available stock', error: error.message });
  }
};

// 2. Create Sale
exports.createSale = async (req, res) => {
  try {
    const {
      sellFrom = 'Shop',
      customerName = 'Walk-in Customer',
      customerMobile = '',
      customerAddress = '',
      items = [],
      discount = 0,
      paymentMode = 'Cash',
      paymentStatus = 'Paid',
      notes = '',
      createdBy: sentBy
    } = req.body;
    const createdBy = (req.user && req.user.role !== 'super_admin' ? req.user.name : sentBy) || req.user?.name || 'Admin';

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Sale must contain at least one item' });
    }
    // Money received at billing, same shape as a Finance collection: { amount, account, mode, reference }.
    // Checked before any stock moves. Bills without it keep the old paymentMode / paymentStatus behaviour.
    const payment = req.body.payment || null;
    if (payment) {
      if (!(Number(payment.amount) >= 0)) return res.status(400).json({ message: 'Amount received must be 0 or more' });
      if (Number(payment.amount) > 0 && !ACCOUNTS.includes(payment.account)) {
        return res.status(400).json({ message: 'Received In must be Cash, Company Bank or Personal Bank' });
      }
      if (Number(payment.amount) > 0 && !PAYMENT_MODES.includes(payment.mode)) {
        return res.status(400).json({ message: 'Invalid payment mode' });
      }
    }

    const saleId = await generateSaleId();
    const processedItems = [];
    let totalTheli = 0;
    let totalWeightKg = 0;
    let subTotal = 0;
    let totalCost = 0;

    // Process each item
    for (const item of items) {
      const {
        productName,
        packetSizeGrams,
        quantityTheli,
        weightKg,
        quantityGram,
        soldQuantity,
        soldUnit,
        rateType = 'theli', // 'theli' | 'kg' | 'gram'
        sellingRate,
        batchSelection = 'AUTO_FIFO', // 'AUTO_FIFO' or specific source ID
        inventorySourceId
      } = item;

      const unit = soldUnit || rateType || 'theli';
      const pktGrams = Number(packetSizeGrams) || 0;
      const rate = Number(sellingRate) || 0;

      let numTheli = 0;
      let calculatedWeightKg = 0;
      let itemAmount = 0;

      if (unit === 'kg') {
        const enteredKg = soldQuantity != null ? Number(soldQuantity) : (weightKg != null && weightKg !== '' ? Number(weightKg) : (Number(quantityTheli) * pktGrams) / 1000);
        calculatedWeightKg = Number(enteredKg.toFixed(3));
        numTheli = pktGrams > 0 ? Number(((calculatedWeightKg * 1000) / pktGrams).toFixed(2)) : (Number(quantityTheli) || 0);
        itemAmount = Number((calculatedWeightKg * rate).toFixed(2));
      } else if (unit === 'gram') {
        const enteredGrams = soldQuantity != null ? Number(soldQuantity) : (quantityGram != null && quantityGram !== '' ? Number(quantityGram) : (weightKg != null && weightKg !== '' ? Number(weightKg) * 1000 : Number(quantityTheli) * pktGrams));
        calculatedWeightKg = Number((enteredGrams / 1000).toFixed(3));
        numTheli = pktGrams > 0 ? Number((enteredGrams / pktGrams).toFixed(2)) : (Number(quantityTheli) || 0);
        itemAmount = Number((enteredGrams * rate).toFixed(2));
      } else {
        numTheli = soldQuantity != null ? Number(soldQuantity) : (Number(quantityTheli) || 0);
        calculatedWeightKg = pktGrams > 0 ? Number(((numTheli * pktGrams) / 1000).toFixed(3)) : (Number(weightKg) || 0);
        itemAmount = Number((numTheli * rate).toFixed(2));
      }

      // Handle Stock Deduction & FIFO / Manual batch
      if (batchSelection !== 'AUTO_FIFO' && inventorySourceId) {
        // Specific Batch Selected
        let stockRecord;
        if (sellFrom === 'Packaging Godown') {
          stockRecord = await ReadyStock.findById(inventorySourceId);
        } else {
          stockRecord = await ShopStock.findById(inventorySourceId);
        }

        if (!stockRecord) {
          return res.status(404).json({ message: `Stock batch not found for ${productName}` });
        }

        if (unit === 'theli') {
          if (stockRecord.availablePackets < numTheli && stockRecord.availableWeightKg < calculatedWeightKg - 0.0001) {
            return res.status(400).json({
              message: `Insufficient stock in batch ${stockRecord.productionBatchId}. Available: ${stockRecord.availablePackets} packets, Requested: ${numTheli}`
            });
          }
        } else {
          if (stockRecord.availableWeightKg < calculatedWeightKg - 0.0001) {
            return res.status(400).json({
              message: `Insufficient stock in batch ${stockRecord.productionBatchId}. Available: ${stockRecord.availableWeightKg} KG, Requested: ${calculatedWeightKg} KG`
            });
          }
        }

        const costPerPkt = Number(stockRecord.costPerPacket) || 0;
        const costKg = Number(stockRecord.costPerKg) || (pktGrams > 0 ? costPerPkt * (1000 / pktGrams) : costPerPkt);
        const costGram = Number(stockRecord.costPerGram) || (costKg / 1000);

        let itemCost = 0;
        if (unit === 'kg') {
          itemCost = Number((calculatedWeightKg * costKg).toFixed(2));
        } else if (unit === 'gram') {
          itemCost = Number(((calculatedWeightKg * 1000) * costGram).toFixed(2));
        } else {
          itemCost = Number((numTheli * costPerPkt).toFixed(2));
        }
        const itemProfit = Number((itemAmount - itemCost).toFixed(2));

        // Deduct
        stockRecord.availablePackets = Math.max(0, Math.round(stockRecord.availablePackets - numTheli));
        stockRecord.availableWeightKg = Math.max(0, Number((stockRecord.availableWeightKg - calculatedWeightKg).toFixed(3)));
        if (stockRecord.availableWeightKg === 0) stockRecord.availablePackets = 0;
        if (sellFrom === 'Packaging Godown') {
          stockRecord.dispatchedPackets = (stockRecord.dispatchedPackets || 0) + numTheli;
          stockRecord.dispatchedWeightKg = Number(((stockRecord.dispatchedWeightKg || 0) + calculatedWeightKg).toFixed(3));
        }
        await stockRecord.save();

        let challanId = '';
        if (stockRecord.dispatchId) {
          const dispatchDoc = await PackagingDispatch.findById(stockRecord.dispatchId);
          if (dispatchDoc) challanId = dispatchDoc.dispatchId;
        }

        processedItems.push({
          productName,
          productionBatchId: stockRecord.productionBatchId,
          stockBatchId: stockRecord.stockBatchId || '',
          challanId,
          storeName: stockRecord.storeName || '',
          packetSizeGrams: pktGrams,
          quantityTheli: numTheli,
          weightKg: calculatedWeightKg,
          rateType: unit,
          soldUnit: unit,
          soldQuantity: unit === 'kg' ? calculatedWeightKg : (unit === 'gram' ? calculatedWeightKg * 1000 : numTheli),
          sellingRate: rate,
          costPerPacket: costPerPkt,
          costPerKg: costKg,
          costPerGram: costGram,
          itemAmount,
          itemCost,
          itemProfit,
          inventorySourceId: stockRecord._id,
          inventoryType: sellFrom === 'Packaging Godown' ? 'ReadyStock' : 'ShopStock'
        });

        totalTheli += numTheli;
        totalWeightKg += calculatedWeightKg;
        subTotal += itemAmount;
        totalCost += itemCost;

      } else {
        // AUTO_FIFO: Allocate across oldest available batches
        let candidateBatches = [];

        if (sellFrom === 'Packaging Godown') {
          candidateBatches = await ReadyStock.find({
            productType: productName,
            packetSizeGrams: pktGrams,
            availableWeightKg: { $gt: 0 }
          }).sort({ productionDate: 1 });
        } else {
          candidateBatches = await ShopStock.find({
            productType: productName,
            packetSizeGrams: pktGrams,
            availableWeightKg: { $gt: 0 }
          }).sort({ receivedDate: 1 });
        }

        if (unit === 'theli') {
          const totalAvailable = candidateBatches.reduce((acc, b) => acc + (b.availablePackets || 0), 0);
          if (totalAvailable < numTheli) {
            return res.status(400).json({
              message: `Insufficient stock for ${productName} (${pktGrams}g). Total Available: ${totalAvailable}, Requested: ${numTheli}`
            });
          }

          let remainingNeeded = numTheli;
          for (const batch of candidateBatches) {
            if (remainingNeeded <= 0) break;

            const takeFromThis = Math.min(batch.availablePackets, remainingNeeded);
            const weightFromThis = Number(((takeFromThis * pktGrams) / 1000).toFixed(3));
            const subItemAmount = Number((takeFromThis * rate).toFixed(2));

            const costPerPkt = Number(batch.costPerPacket) || 0;
            const costKg = Number(batch.costPerKg) || (pktGrams > 0 ? costPerPkt * (1000 / pktGrams) : costPerPkt);
            const costGram = Number(batch.costPerGram) || (costKg / 1000);
            const subItemCost = Number((takeFromThis * costPerPkt).toFixed(2));
            const subItemProfit = Number((subItemAmount - subItemCost).toFixed(2));

            batch.availablePackets -= takeFromThis;
            batch.availableWeightKg = Math.max(0, Number((batch.availableWeightKg - weightFromThis).toFixed(3)));
            if (batch.availableWeightKg === 0) batch.availablePackets = 0;
            if (sellFrom === 'Packaging Godown') {
              batch.dispatchedPackets = (batch.dispatchedPackets || 0) + takeFromThis;
              batch.dispatchedWeightKg = Number(((batch.dispatchedWeightKg || 0) + weightFromThis).toFixed(3));
            }
            await batch.save();

            let challanId = '';
            if (batch.dispatchId) {
              const dispatchDoc = await PackagingDispatch.findById(batch.dispatchId);
              if (dispatchDoc) challanId = dispatchDoc.dispatchId;
            }

            processedItems.push({
              productName,
              productionBatchId: batch.productionBatchId,
              stockBatchId: batch.stockBatchId || '',
              challanId,
              storeName: batch.storeName || '',
              packetSizeGrams: pktGrams,
              quantityTheli: takeFromThis,
              weightKg: weightFromThis,
              rateType: 'theli',
              soldUnit: 'theli',
              soldQuantity: takeFromThis,
              sellingRate: rate,
              costPerPacket,
              costPerKg,
              costPerGram,
              itemAmount: subItemAmount,
              itemCost: subItemCost,
              itemProfit: subItemProfit,
              inventorySourceId: batch._id,
              inventoryType: sellFrom === 'Packaging Godown' ? 'ReadyStock' : 'ShopStock'
            });

            totalTheli += takeFromThis;
            totalWeightKg += weightFromThis;
            subTotal += subItemAmount;
            totalCost += subItemCost;
            remainingNeeded -= takeFromThis;
          }
        } else {
          // Weight-based FIFO (KG or Gram)
          const totalAvailKg = candidateBatches.reduce((acc, b) => acc + (b.availableWeightKg || 0), 0);
          if (totalAvailKg < calculatedWeightKg - 0.0001) {
            return res.status(400).json({
              message: `Insufficient stock for ${productName}. Total Available: ${totalAvailKg.toFixed(2)} KG, Requested: ${calculatedWeightKg} KG`
            });
          }

          let remainingWeight = calculatedWeightKg;
          for (const batch of candidateBatches) {
            if (remainingWeight <= 0.0001) break;

            const weightFromThis = Math.min(batch.availableWeightKg, remainingWeight);
            const theliFromThis = pktGrams > 0 ? Number(((weightFromThis * 1000) / pktGrams).toFixed(2)) : 0;
            
            let subItemAmount = 0;
            if (unit === 'kg') {
              subItemAmount = Number((weightFromThis * rate).toFixed(2));
            } else {
              subItemAmount = Number(((weightFromThis * 1000) * rate).toFixed(2));
            }

            const costPerPkt = Number(batch.costPerPacket) || 0;
            const costKg = Number(batch.costPerKg) || (pktGrams > 0 ? costPerPkt * (1000 / pktGrams) : costPerPkt);
            const costGram = Number(batch.costPerGram) || (costKg / 1000);

            let subItemCost = 0;
            if (unit === 'kg') {
              subItemCost = Number((weightFromThis * costKg).toFixed(2));
            } else {
              subItemCost = Number(((weightFromThis * 1000) * costGram).toFixed(2));
            }
            const subItemProfit = Number((subItemAmount - subItemCost).toFixed(2));

            batch.availableWeightKg = Math.max(0, Number((batch.availableWeightKg - weightFromThis).toFixed(3)));
            batch.availablePackets = Math.max(0, Math.round(batch.availablePackets - theliFromThis));
            if (batch.availableWeightKg === 0) batch.availablePackets = 0;
            if (sellFrom === 'Packaging Godown') {
              batch.dispatchedPackets = (batch.dispatchedPackets || 0) + theliFromThis;
              batch.dispatchedWeightKg = Number(((batch.dispatchedWeightKg || 0) + weightFromThis).toFixed(3));
            }
            await batch.save();

            let challanId = '';
            if (batch.dispatchId) {
              const dispatchDoc = await PackagingDispatch.findById(batch.dispatchId);
              if (dispatchDoc) challanId = dispatchDoc.dispatchId;
            }

            processedItems.push({
              productName,
              productionBatchId: batch.productionBatchId,
              stockBatchId: batch.stockBatchId || '',
              challanId,
              storeName: batch.storeName || '',
              packetSizeGrams: pktGrams,
              quantityTheli: theliFromThis,
              weightKg: weightFromThis,
              rateType: unit,
              soldUnit: unit,
              soldQuantity: unit === 'kg' ? weightFromThis : weightFromThis * 1000,
              sellingRate: rate,
              costPerPacket,
              costPerKg,
              costPerGram,
              itemAmount: subItemAmount,
              itemCost: subItemCost,
              itemProfit: subItemProfit,
              inventorySourceId: batch._id,
              inventoryType: sellFrom === 'Packaging Godown' ? 'ReadyStock' : 'ShopStock'
            });

            totalTheli += theliFromThis;
            totalWeightKg += weightFromThis;
            subTotal += subItemAmount;
            totalCost += subItemCost;
            remainingWeight -= weightFromThis;
          }
        }
      }
    }

    const discountAmount = Number(discount) || 0;
    const finalAmount = Math.max(0, subTotal - discountAmount);
    const totalProfit = finalAmount - totalCost;

    const newSale = new Sale({
      saleId,
      saleDate: new Date(),
      sellFrom,
      customerName: customerName.trim() || 'Walk-in Customer',
      customerMobile,
      customerAddress,
      items: processedItems,
      totalTheli,
      totalWeightKg: Number(totalWeightKg.toFixed(2)),
      subTotal: Number(subTotal.toFixed(2)),
      discount: discountAmount,
      finalAmount: Number(finalAmount.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
      totalProfit: Number(totalProfit.toFixed(2)),
      paymentMode,
      paymentStatus,
      notes,
      createdBy: createdBy || 'Admin'
    });

    await newSale.save();
    if (payment) {
      // Never more than the bill; the rest stays due and can be collected later in Payment & Finance
      const amt = Math.min(round2(payment.amount), round2(newSale.finalAmount));
      if (amt > 0) {
        await Payment.create({
          paymentId: await nextPaymentId(),
          sale: newSale._id,
          billNo: newSale.saleId,
          partyName: newSale.customerName,
          amount: amt,
          mode: payment.mode,
          account: payment.account,
          paymentDate: newSale.saleDate,
          reference: String(payment.reference || ''),
          notes: 'Paid at billing',
          createdBy: newSale.createdBy
        });
      }
      newSale.amountPaid = amt;
      newSale.paymentStatus = statusFor(amt, round2(newSale.finalAmount));
      newSale.paymentMode = amt > 0 ? payment.mode : 'Credit';
      await newSale.save();
    } else {
      await recordSaleAtBilling(newSale);
    }
    res.status(201).json(newSale);

  } catch (error) {
    console.error('Error creating sale:', error);
    res.status(500).json({ message: 'Error creating sale', error: error.message });
  }
};

// 3. Get All Sales with Filtering & Search
exports.getSales = async (req, res) => {
  try {
    const { search, sellFrom, startDate, endDate, month, year } = req.query;
    let query = {};

    if (search) {
      query.$or = [
        { saleId: new RegExp(search, 'i') },
        { customerName: new RegExp(search, 'i') },
        { customerMobile: new RegExp(search, 'i') },
        { 'items.productName': new RegExp(search, 'i') }
      ];
    }

    if (sellFrom && sellFrom !== 'All') {
      query.sellFrom = sellFrom;
    }

    if (startDate && endDate) {
      query.saleDate = {
        $gte: new Date(new Date(startDate).setHours(0, 0, 0, 0)),
        $lte: new Date(new Date(endDate).setHours(23, 59, 59, 999))
      };
    } else if (month && year) {
      const m = parseInt(month, 10);
      const y = parseInt(year, 10);
      const startOfMonth = new Date(y, m - 1, 1);
      const endOfMonth = new Date(y, m, 0, 23, 59, 59, 999);
      query.saleDate = { $gte: startOfMonth, $lte: endOfMonth };
    }

    const sales = await Sale.find(query).sort({ saleDate: -1, createdAt: -1 });
    res.json(sales);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching sales', error: error.message });
  }
};

// 4. Get Sale by ID
exports.getSaleById = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) return res.status(404).json({ message: 'Sale not found' });
    res.json(sale);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching sale', error: error.message });
  }
};

// 5. Delete Sale & Restore Stock
exports.deleteSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) return res.status(404).json({ message: 'Sale not found' });

    // Restore stock for each item
    for (const item of sale.items) {
      if (item.inventorySourceId) {
        if (item.inventoryType === 'ReadyStock') {
          const readyStock = await ReadyStock.findById(item.inventorySourceId);
          if (readyStock) {
            readyStock.availablePackets += item.quantityTheli;
            readyStock.availableWeightKg += item.weightKg;
            await readyStock.save();
          }
        } else {
          const shopStock = await ShopStock.findById(item.inventorySourceId);
          if (shopStock) {
            shopStock.availablePackets += item.quantityTheli;
            shopStock.availableWeightKg += item.weightKg;
            await shopStock.save();
          }
        }
      }
    }

    await Sale.findByIdAndDelete(req.params.id);
    await Payment.deleteMany({ sale: sale._id });
    res.json({ message: 'Sale deleted and stock restored successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting sale', error: error.message });
  }
};

// 6. Get Sales Summary / Stats
// Customers billed before (newest details first), for the name dropdown in a new sale
exports.getCustomers = async (req, res) => {
  try {
    const rows = await Sale.aggregate([
      { $match: { customerName: { $nin: ['', null, 'Walk-in Customer'] } } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: { $toLower: { $trim: { input: '$customerName' } } },
        name: { $first: { $trim: { input: '$customerName' } } },
        mobiles: { $push: '$customerMobile' },
        addresses: { $push: '$customerAddress' }
      } },
      { $sort: { name: 1 } }
    ]);
    // Latest non-empty mobile / address (some bills were made without them)
    const latest = (list) => (list || []).find(v => v && String(v).trim()) || '';
    res.json(rows.map(r => ({ name: r.name, mobile: latest(r.mobiles), address: latest(r.addresses) })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getSalesStats = async (req, res) => {
  try {
    const sales = await Sale.find();
    const totalRevenue = sales.reduce((sum, s) => sum + (s.finalAmount || 0), 0);
    const totalProfit = sales.reduce((sum, s) => sum + (s.totalProfit || 0), 0);
    const totalTheliSold = sales.reduce((sum, s) => sum + (s.totalTheli || 0), 0);
    const totalWeightSoldKg = sales.reduce((sum, s) => sum + (s.totalWeightKg || 0), 0);

    res.json({
      totalSalesCount: sales.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalProfit: Number(totalProfit.toFixed(2)),
      totalTheliSold,
      totalWeightSoldKg: Number(totalWeightSoldKg.toFixed(2))
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching sales stats', error: error.message });
  }
};

// 7. Get Store Inward Dispatches and Ready Stock
exports.getStoreInventory = async (req, res) => {
  try {
    const { storeName } = req.query;
    let dispatchQuery = {};
    let stockQuery = {};

    if (storeName && storeName !== 'All') {
      dispatchQuery.destinationStore = new RegExp('^' + storeName.trim() + '$', 'i');
      stockQuery.storeName = new RegExp('^' + storeName.trim() + '$', 'i');
    }

    const dispatches = await PackagingDispatch.find(dispatchQuery).sort({ dispatchedAt: -1, createdAt: -1 });
    const shopStocks = await ShopStock.find({ ...stockQuery, availablePackets: { $gt: 0 } }).sort({ receivedDate: -1 });

    res.json({
      dispatches,
      shopStocks
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching store inventory', error: error.message });
  }
};

// 8. Confirm Dispatch Received at Shop
exports.confirmDispatchReceived = async (req, res) => {
  try {
    const { id } = req.params;
    const dispatch = await PackagingDispatch.findById(id);
    if (!dispatch) return res.status(404).json({ message: 'Dispatch not found' });
    if (dispatch.isReceivedAtShop) return res.status(400).json({ message: 'This dispatch is already received' });

    // Packets sent vs packets that reached the store (no body = everything arrived)
    const sent = Number(dispatch.packetsToDispatch) || 0;
    const body = req.body || {};
    const receivedPackets = body.receivedPackets !== undefined ? Number(body.receivedPackets) : sent;
    if (!Number.isInteger(receivedPackets) || receivedPackets < 0 || receivedPackets > sent) {
      return res.status(400).json({ message: `Received packets must be a whole number between 0 and ${sent}` });
    }
    if (body.receiveLoss && !Number.isInteger(Number(body.receiveLoss.wastageQty) || 0)) {
      return res.status(400).json({ message: 'Damaged packets must be a whole number' });
    }
    const loss = buildSplit({ expected: sent, actual: receivedPackets, input: body.receiveLoss, mode: 'gap', unitLabel: 'packets' });
    if (loss.error) return res.status(400).json({ message: loss.error });

    dispatch.isReceivedAtShop = true;
    dispatch.status = 'RECEIVED';
    dispatch.receivedAt = new Date();
    dispatch.receivedPackets = receivedPackets;
    dispatch.receivedBy = body.receivedBy || req.user?.name || dispatch.destinationStore;
    dispatch.receiveLoss = loss.split;
    await dispatch.save();

    // Store stock was created at dispatch time with every packet sent — keep only the good packets
    // received; the gap (wastage + difference) comes out
    const gap = sent - receivedPackets;
    if (gap > 0) {
      const shopStock = await ShopStock.findOne({ dispatchId: dispatch._id });
      if (shopStock) {
        const kgPerPacket = (Number(shopStock.packetSizeGrams) || 0) / 1000;
        shopStock.totalPackets = Math.max(0, shopStock.totalPackets - gap);
        shopStock.totalWeightKg = Math.max(0, shopStock.totalPackets * kgPerPacket);
        shopStock.availablePackets = Math.max(0, shopStock.availablePackets - gap);
        shopStock.availableWeightKg = Math.max(0, shopStock.availablePackets * kgPerPacket);
        await shopStock.save();
      }
    }

    await recordLoss({
      stage: 'STORE_RECEIVE', unit: 'THELI', refModel: 'PackagingDispatch', refId: dispatch._id, refCode: dispatch.dispatchId,
      productName: dispatch.productType, stockBatchId: dispatch.stockBatchId, packetSizeGrams: dispatch.packetSizeGrams,
      party: dispatch.destinationStore, split: loss.split, recordedBy: dispatch.receivedBy, entryDate: dispatch.receivedAt
    });

    res.json({ message: 'Dispatch marked as received at store', dispatch });
  } catch (error) {
    res.status(500).json({ message: 'Error confirming dispatch receipt', error: error.message });
  }
};

// 9. Update Store Ready Stock
exports.updateShopStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { availablePackets, availableWeightKg, storeName } = req.body;
    const stock = await ShopStock.findById(id);
    if (!stock) return res.status(404).json({ message: 'Store stock not found' });

    if (availablePackets !== undefined) stock.availablePackets = Number(availablePackets);
    if (availableWeightKg !== undefined) stock.availableWeightKg = Number(availableWeightKg);
    if (storeName) stock.storeName = storeName;

    await stock.save();
    res.json(stock);
  } catch (error) {
    res.status(500).json({ message: 'Error updating store stock', error: error.message });
  }
};

// 10. Delete Store Ready Stock
exports.deleteShopStock = async (req, res) => {
  try {
    const { id } = req.params;
    const stock = await ShopStock.findById(id);
    if (!stock) return res.status(404).json({ message: 'Store stock not found' });

    // Restore ReadyStock in packaging if dispatch linked
    if (stock.readyStockId) {
      const readyStock = await ReadyStock.findById(stock.readyStockId);
      if (readyStock) {
        readyStock.availablePackets += (stock.availablePackets || 0);
        readyStock.availableWeightKg += (stock.availableWeightKg || 0);
        readyStock.dispatchedPackets = Math.max(0, (readyStock.dispatchedPackets || 0) - (stock.availablePackets || 0));
        await readyStock.save();
      }
    }

    if (stock.dispatchId) {
      await PackagingDispatch.findByIdAndDelete(stock.dispatchId);
    }

    await ShopStock.findByIdAndDelete(id);
    res.json({ message: 'Store stock deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting store stock', error: error.message });
  }
};
