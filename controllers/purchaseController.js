const Purchase = require('../models/Purchase');
const Stock = require('../models/Stock');
const ReadyStock = require('../models/ReadyStock');
const { recalcReadyStock } = require('../utils/costing');
const { buildSplit, resplit, splitSummary, recordLoss, removeLoss } = require('../utils/lossLedger');
const Expense = require('../models/Expense');
const { round2, purchasePaid, purchasePaymentError, payPurchase, fundsError } = require('../utils/finance');

const receivedOf = (p) => (p.receivedQuantity != null ? Number(p.receivedQuantity) : Number(p.quantity) || 0);

// Validate the ordered-vs-received split sent by the client (null when the client sent none)
const splitFromBody = (body, quantity, receivedQty) => {
  if (!body.loss) return { split: null };
  return buildSplit({ expected: quantity, actual: receivedQty, input: body.loss, mode: 'received', unitLabel: 'KG' });
};

// Move damaged quantity in / out of the stock batch so usable stock = received - wastage
const applyStockWastage = async (purchase, stock, wastageQty) => {
  const delta = (Number(wastageQty) || 0) - (Number(purchase.stockWastageQty) || 0);
  if (!stock || delta === 0) return;
  stock.purchasedQuantity = Number(stock.purchasedQuantity) - delta;
  stock.remainingQuantity = Math.max(0, Number(stock.remainingQuantity) - delta);
  await stock.save();
  purchase.stockWastageQty = Number(wastageQty) || 0;
};

// Stage 1 of the loss ledger: ordered vs received at the shop godown
const syncPurchaseLoss = async (purchase, split) => {
  const stock = await Stock.findOne({ purchaseId: purchase._id });
  if (purchase.status !== 'Completed') {
    await removeLoss(purchase._id, 'PURCHASE_RECEIVE');
    if (purchase.receiveLoss) {
      purchase.receiveLoss = undefined;
      await purchase.save();
    }
    return;
  }
  const finalSplit = split || resplit(
    purchase.receiveLoss || { differenceReason: purchase.wasteReason || '' },
    Number(purchase.quantity) || 0,
    receivedOf(purchase),
    'received'
  );
  await applyStockWastage(purchase, stock, finalSplit.wastageQty);
  purchase.receiveLoss = finalSplit;
  purchase.wasteReason = splitSummary(finalSplit, 'KG');
  await purchase.save();

  await recordLoss({
    stage: 'PURCHASE_RECEIVE', unit: 'KG', refModel: 'Purchase', refId: purchase._id, refCode: purchase.purchaseId,
    productName: purchase.item, stockBatchId: stock ? stock.batchId : '', party: purchase.supplier,
    split: finalSplit, recordedBy: purchase.createdBy, entryDate: purchase.purchaseDate
  });
};

// Helper to create or update stock batch for a purchase (each purchase gets its own separate batch - NO averaging)
const createStockBatch = async (purchase) => {
  const prodName = (purchase.item || '').trim();
  const incomingQty = purchase.receivedQuantity != null ? Number(purchase.receivedQuantity) : Number(purchase.quantity);
  const incomingRate = Number(purchase.rate) || 0;

  // Check if stock already exists for THIS specific purchase
  let stock = await Stock.findOne({ purchaseId: purchase._id });

  if (stock) {
    // Update existing batch for this purchase
    const diff = incomingQty - (Number(stock.purchasedQuantity) || 0);
    stock.purchasedQuantity = incomingQty;
    stock.remainingQuantity = Math.max(0, (Number(stock.remainingQuantity) || 0) + diff);
    stock.purchaseRate = incomingRate;
    stock.productName = prodName;
    stock.supplier = purchase.supplier;
    stock.purchaseDate = purchase.purchaseDate;
    if (purchase.costingUnit) stock.costingUnit = purchase.costingUnit;
    stock.status = stock.remainingQuantity > 0 ? 'Available' : 'Consumed';

    await stock.save();
    return stock;
  }

  // Generate unique BATCH-XXXX
  const allStocks = await Stock.find({}, { batchId: 1 }).lean();
  let maxNum = 0;
  allStocks.forEach(s => {
    if (s.batchId && s.batchId.startsWith('BATCH-')) {
      const num = parseInt(s.batchId.replace('BATCH-', ''), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  });
  const nextNum = maxNum + 1;
  const batchId = `BATCH-${nextNum.toString().padStart(4, '0')}`;

  const newStock = new Stock({
    batchId,
    purchaseId: purchase._id,
    productName: prodName,
    supplier: purchase.supplier,
    purchaseDate: purchase.purchaseDate,
    purchaseRate: incomingRate,
    purchasedQuantity: incomingQty,
    remainingQuantity: incomingQty,
    location: "Shop",
    costingUnit: purchase.costingUnit || 'kg',
    status: "Available",
    createdBy: purchase.createdBy
  });

  await newStock.save();
  return newStock;
};

// Get all purchases
exports.getPurchases = async (req, res) => {
  try {
    const [purchases, expenses] = await Promise.all([
      Purchase.find().sort({ createdAt: -1 }),
      Expense.find({ purchase: { $ne: null } }).sort({ expenseDate: 1, createdAt: 1 })
        .select('purchase expenseId amount paidFrom expenseDate reference')
    ]);
    // Supplier payments per bill (Purchase expenses), so the list shows paid / due and from which account
    const byPurchase = {};
    expenses.forEach(e => { (byPurchase[e.purchase] = byPurchase[e.purchase] || []).push(e); });
    res.status(200).json(purchases.map(p => ({ ...p.toObject(), payments: byPurchase[p._id] || [] })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching purchases', error: error.message });
  }
};

// Add a new purchase
exports.addPurchase = async (req, res) => {
  try {
    // Generate a unique Purchase ID
    const lastPurchase = await Purchase.findOne().sort({ purchaseId: -1 });
    let nextNum = 1;
    if (lastPurchase && lastPurchase.purchaseId && lastPurchase.purchaseId.startsWith('PUR-')) {
      const lastNum = parseInt(lastPurchase.purchaseId.replace('PUR-', ''), 10);
      if (!isNaN(lastNum)) {
        nextNum = lastNum + 1;
      }
    }
    const sequenceNumber = nextNum.toString().padStart(3, '0');
    const purchaseId = `PUR-${sequenceNumber}`;

    // Money paid to the supplier now (only when the purchase is added as Completed)
    const { payment, ...body } = req.body;
    if (body.billNumber !== undefined) body.billNumber = String(body.billNumber).trim();
    if (body.partyMobileNumber !== undefined) body.partyMobileNumber = String(body.partyMobileNumber).trim();
    // Created by = the logged-in panel (store name); super admin keeps the name the form sends
    if (req.user && req.user.role !== 'super_admin') body.createdBy = req.user.name;
    if (!body.createdBy) body.createdBy = req.user?.name || 'Admin';
    const payNow = body.status === 'Completed' ? payment : null;
    const payErr = purchasePaymentError(payNow, Number(body.totalPrice) || 0)
      || (payNow && await fundsError(payNow.paidFrom, payNow.amount));
    if (payErr) return res.status(400).json({ message: payErr });

    // Added as received: ordered vs received split (reason needed when they differ)
    let split = null;
    if (body.status === 'Completed' && body.receivedQuantity != null) {
      const checked = splitFromBody(req.body, Number(body.quantity) || 0, Number(body.receivedQuantity));
      if (checked.error) return res.status(400).json({ message: checked.error });
      split = checked.split;
    }

    // Driver freight calculation (strictly per KG in Rupees or Paise)
    const wt = body.receivedQuantity != null ? Number(body.receivedQuantity) : Number(body.quantity) || 0;
    const dRate = Number(body.driverRatePerKg) || 0;
    const dUnit = body.driverRateUnit === 'paise' ? 'paise' : 'rupee';
    if (dRate > 0) {
      body.driverFreightTotal = dUnit === 'paise'
        ? Math.round((wt * dRate / 100) * 100) / 100
        : Math.round((wt * dRate) * 100) / 100;
      if (!body.transportCost || Number(body.transportCost) === 0) {
        body.transportCost = dUnit === 'paise' ? (dRate / 100) : dRate;
      }
    }

    const newPurchase = new Purchase({
      ...body,
      purchaseId,
      amountPaid: 0
    });

    const savedPurchase = await newPurchase.save();

    // Create stock batch if completed
    if (savedPurchase.status === 'Completed') {
      await createStockBatch(savedPurchase);
      await syncPurchaseLoss(savedPurchase, split);
      if (payNow) {
        await payPurchase(savedPurchase, {
          ...payNow,
          expenseDate: payNow.expenseDate || savedPurchase.purchaseDate,
          createdBy: savedPurchase.createdBy
        });
      }
    }

    res.status(201).json(savedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error adding purchase', error: error.message });
  }
};

// Delete a purchase
exports.deletePurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPurchase = await Purchase.findByIdAndDelete(id);
    if (!deletedPurchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Delete the corresponding stock batch created specifically for this purchase
    await Stock.findOneAndDelete({ purchaseId: deletedPurchase._id });
    await removeLoss(id);
    await Expense.deleteMany({ purchase: id });

    res.status(200).json({ message: 'Purchase and associated stock batch removed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting purchase', error: error.message });
  }
};

// Update purchase status
exports.updatePurchaseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, receivedQty, wasteReason, payment, paidBy, billNumber, partyMobileNumber } = req.body;

    let updateFields = { status };
    if (billNumber !== undefined) updateFields.billNumber = String(billNumber).trim();
    if (partyMobileNumber !== undefined) updateFields.partyMobileNumber = String(partyMobileNumber).trim();
    let purchase = null;
    let split = null;

    // Supplier payment made while completing: check it against the bill total after this change
    const payNow = status === 'Completed' && round2(payment?.amount) > 0 ? payment : null;
    if (payNow) {
      const current = await Purchase.findById(id);
      if (!current) return res.status(404).json({ message: 'Purchase not found' });
      const newTotal = receivedQty !== undefined ? Number(receivedQty) * current.rate : Number(current.totalPrice) || 0;
      const payErr = purchasePaymentError(payNow, newTotal - purchasePaid(current))
        || await fundsError(payNow.paidFrom, payNow.amount);
      if (payErr) return res.status(400).json({ message: payErr });
    }

    if (receivedQty !== undefined) {
      purchase = await Purchase.findById(id);
      if (purchase) {
        if (status === 'Completed') {
          const checked = splitFromBody(req.body, purchase.quantity, Number(receivedQty));
          if (checked.error) return res.status(400).json({ message: checked.error });
          split = checked.split;
        }
        updateFields.receivedQuantity = Number(receivedQty);
        updateFields.totalPrice = Number(receivedQty) * purchase.rate;
        if (wasteReason !== undefined) {
          updateFields.wasteReason = wasteReason;
        }
        if (purchase.driverRatePerKg && purchase.driverRatePerKg > 0) {
          const dRate = purchase.driverRatePerKg;
          const dUnit = purchase.driverRateUnit || 'rupee';
          updateFields.driverFreightTotal = dUnit === 'paise'
            ? Math.round((Number(receivedQty) * dRate / 100) * 100) / 100
            : Math.round((Number(receivedQty) * dRate) * 100) / 100;
        }
      }
    }

    const updatedPurchase = await Purchase.findByIdAndUpdate(
      id,
      updateFields,
      { new: true }
    );
    if (!updatedPurchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    
    // Create or update stock for this specific purchase batch
    if (updatedPurchase.status === 'Completed') {
      await createStockBatch(updatedPurchase);
    } else {
      await Stock.findOneAndDelete({ purchaseId: updatedPurchase._id });
    }
    await syncPurchaseLoss(updatedPurchase, split);
    if (payNow) await payPurchase(updatedPurchase, { ...payNow, createdBy: paidBy || updatedPurchase.createdBy });

    res.status(200).json(updatedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error updating status', error: error.message });
  }
};

// Update purchase fully
exports.updatePurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (updates.billNumber !== undefined) updates.billNumber = String(updates.billNumber).trim();
    if (updates.partyMobileNumber !== undefined) updates.partyMobileNumber = String(updates.partyMobileNumber).trim();
    
    const purchase = await Purchase.findById(id);
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }

    // Validate the wastage / difference split against the final quantities
    let split = null;
    const finalStatus = updates.status || purchase.status;
    if (finalStatus === 'Completed' && updates.loss) {
      const qty = updates.quantity !== undefined ? Number(updates.quantity) : Number(purchase.quantity);
      const got = updates.receivedQuantity !== undefined ? Number(updates.receivedQuantity) : receivedOf(purchase);
      const checked = splitFromBody(updates, qty, got);
      if (checked.error) return res.status(400).json({ message: checked.error });
      split = checked.split;
    }
    delete updates.loss;
    delete updates.receiveLoss;
    delete updates.amountPaid; // only changed through finance payments

    // Recalculate total price if rate or receivedQty changes
    if (updates.receivedQuantity !== undefined && updates.rate !== undefined) {
       updates.totalPrice = Number(updates.receivedQuantity) * Number(updates.rate);
    } else if (updates.receivedQuantity !== undefined) {
       updates.totalPrice = Number(updates.receivedQuantity) * purchase.rate;
    } else if (updates.rate !== undefined) {
       updates.totalPrice = (purchase.receivedQuantity || purchase.quantity) * Number(updates.rate);
    }

    // Recalculate driver freight total
    const effectiveQty = updates.receivedQuantity !== undefined
      ? Number(updates.receivedQuantity)
      : (updates.quantity !== undefined ? Number(updates.quantity) : (purchase.receivedQuantity != null ? purchase.receivedQuantity : purchase.quantity));
    const effectiveRate = updates.driverRatePerKg !== undefined ? Number(updates.driverRatePerKg) : (purchase.driverRatePerKg || 0);
    const effectiveUnit = updates.driverRateUnit !== undefined ? updates.driverRateUnit : (purchase.driverRateUnit || 'rupee');
    if (effectiveRate > 0) {
      updates.driverFreightTotal = effectiveUnit === 'paise'
        ? Math.round((effectiveQty * effectiveRate / 100) * 100) / 100
        : Math.round((effectiveQty * effectiveRate) * 100) / 100;
      if (updates.transportCost === undefined && (!purchase.transportCost || purchase.transportCost === 0)) {
        updates.transportCost = effectiveUnit === 'paise' ? (effectiveRate / 100) : effectiveRate;
      }
    }

    const updatedPurchase = await Purchase.findByIdAndUpdate(
      id,
      updates,
      { new: true }
    );
    
    if (updatedPurchase.status === 'Completed') {
      await createStockBatch(updatedPurchase);
    } else {
      await Stock.findOneAndDelete({ purchaseId: updatedPurchase._id });
    }
    await syncPurchaseLoss(updatedPurchase, split);

    // Rate, per-theli costs, or costing unit changed: re-cost the theli already packed from this batch
    const costChanged = ['rate', 'packagingCost', 'transportCost', 'otherCost']
      .some(k => updates[k] !== undefined && Number(updates[k]) !== (Number(purchase[k]) || 0))
      || (updates.costingUnit !== undefined && updates.costingUnit !== purchase.costingUnit);
    if (costChanged) {
      const stockBatch = await Stock.findOne({ purchaseId: updatedPurchase._id });
      if (stockBatch) {
        if (updates.rate !== undefined) {
          stockBatch.purchaseRate = Number(updates.rate);
        }
        if (updates.costingUnit !== undefined) {
          stockBatch.costingUnit = updates.costingUnit;
        }
        await stockBatch.save();
        const packed = await ReadyStock.find({ stockBatchId: stockBatch.batchId });
        for (const rs of packed) {
          if (updates.costingUnit !== undefined) {
            rs.costingUnit = updates.costingUnit;
          }
          await recalcReadyStock(rs);
        }
      }
    }
    
    res.status(200).json(updatedPurchase);
  } catch (error) {
    res.status(500).json({ message: 'Error updating purchase', error: error.message });
  }
};

