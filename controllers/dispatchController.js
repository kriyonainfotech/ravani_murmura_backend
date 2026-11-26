const PackagingDispatch = require('../models/PackagingDispatch');
const ReadyStock = require('../models/ReadyStock');
const ShopStock = require('../models/ShopStock');
const { buildSplit, splitSummary, recordLoss, removeLoss } = require('../utils/lossLedger');

// Stage 4 of the loss ledger: packets taken from ready stock vs good packets loaded
const syncDispatchLoss = async (dispatch) => {
  if (!dispatch.dispatchLoss) return;
  await recordLoss({
    stage: 'DISPATCH', unit: 'THELI', refModel: 'PackagingDispatch', refId: dispatch._id, refCode: dispatch.dispatchId,
    productName: dispatch.productType, stockBatchId: dispatch.stockBatchId, packetSizeGrams: dispatch.packetSizeGrams,
    party: dispatch.destinationStore, split: dispatch.dispatchLoss, recordedBy: dispatch.preparedBy, entryDate: dispatch.dispatchedAt
  });
};

// Helper to get next sequential Challan ID (e.g. CH-1, CH-2, ...)
const getNextChallanId = async () => {
  const dispatches = await PackagingDispatch.find().select('dispatchId');
  let maxNum = 0;
  for (const d of dispatches) {
    if (d.dispatchId) {
      const match = d.dispatchId.match(/^CH-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
  }
  return `CH-${maxNum + 1}`;
};

exports.getNextChallanIdEndpoint = async (req, res) => {
  try {
    const nextId = await getNextChallanId();
    res.status(200).json({ nextChallanId: nextId });
  } catch (error) {
    res.status(500).json({ message: 'Error generating next challan ID', error: error.message });
  }
};

exports.createReadyDispatch = async (req, res) => {
  try {
    const { 
      dispatchId: customDispatchId,
      readyStockId, packetsToDispatch, destinationStore, destinationAddress, fromAddress,
      driverId, driverName, driverMobileNumber, tempoNumberPlate,
      driverRatePerKg, driverRateUnit, driverFreightTotal,
      notes, preparedBy,
      wastageKg, wastageReason
    } = req.body;

    const readyStock = await ReadyStock.findById(readyStockId);
    if (!readyStock) return res.status(404).json({ message: 'Ready Stock not found' });

    // Packets found damaged (wastage) or missing (difference) while loading come out of ready stock too
    const input = req.body.dispatchLoss || {};
    const lostW = Number(input.wastageQty) || 0;
    const lostD = Number(input.differenceQty) || 0;
    if (!Number.isInteger(lostW) || !Number.isInteger(lostD) || lostW < 0 || lostD < 0) {
      return res.status(400).json({ message: 'Damaged / missing packets must be whole numbers' });
    }
    const loss = buildSplit({
      expected: Number(packetsToDispatch) + lostW + lostD, input, mode: 'direct', unitLabel: 'packets'
    });
    if (loss.error) return res.status(400).json({ message: loss.error });
    const packetsTaken = loss.split.expectedQty;

    if (readyStock.availablePackets < packetsTaken) {
      return res.status(400).json({ message: lostW + lostD > 0
        ? `Insufficient ready stock: ${packetsTaken} packets needed (incl. ${lostW + lostD} damaged / missing), ${readyStock.availablePackets} available`
        : 'Insufficient ready stock' });
    }

    const weightToDispatchKg = (packetsToDispatch * readyStock.packetSizeGrams) / 1000;
    const kgPerPacket = readyStock.packetSizeGrams / 1000;

    let dispatchId = customDispatchId ? String(customDispatchId).trim() : '';
    if (!dispatchId) {
      dispatchId = await getNextChallanId();
    } else {
      const existing = await PackagingDispatch.findOne({ dispatchId });
      if (existing) {
        return res.status(400).json({ message: `Challan number "${dispatchId}" already exists.` });
      }
    }
    
    const rate = Number(driverRatePerKg) || 0;
    const unit = driverRateUnit === 'paise' ? 'paise' : 'rupee';
    let calculatedFreight = Number(driverFreightTotal) || 0;
    if (rate > 0 && !calculatedFreight) {
      calculatedFreight = unit === 'paise'
        ? Math.round((weightToDispatchKg * rate / 100) * 100) / 100
        : Math.round((weightToDispatchKg * rate) * 100) / 100;
    }

    const newDispatch = new PackagingDispatch({
      dispatchId,
      readyStockId,
      productionBatchId: readyStock.productionBatchId,
      stockBatchId: readyStock.stockBatchId,
      productType: readyStock.productType,
      packetSizeGrams: readyStock.packetSizeGrams,
      packetsToDispatch,
      weightToDispatchKg,
      destinationStore,
      destinationAddress,
      fromAddress,
      driverId: driverId || null,
      driverName: driverName || '',
      driverMobileNumber: driverMobileNumber || '',
      tempoNumberPlate: tempoNumberPlate || '',
      driverRatePerKg: rate,
      driverRateUnit: unit,
      driverFreightTotal: calculatedFreight,
      notes,
      wastageKg: req.body.dispatchLoss ? loss.split.wastageQty * kgPerPacket : (wastageKg ? Number(wastageKg) : 0),
      wastageReason: req.body.dispatchLoss ? splitSummary(loss.split, 'pkts') : (wastageReason || ''),
      dispatchLoss: loss.split,
      preparedBy: (req.user?.role === 'packaging' ? req.user.name : preparedBy) || req.user?.name || 'Packaging User'
    });

    await newDispatch.save();

    const lostPackets = lostW + lostD;
    readyStock.availablePackets -= packetsTaken;
    readyStock.availableWeightKg -= weightToDispatchKg + lostPackets * kgPerPacket;
    readyStock.dispatchedPackets += Number(packetsToDispatch);
    readyStock.dispatchedWeightKg += weightToDispatchKg;
    readyStock.lostPackets = (readyStock.lostPackets || 0) + lostPackets;
    readyStock.lostWeightKg = (readyStock.lostWeightKg || 0) + lostPackets * kgPerPacket;
    await readyStock.save();
    await syncDispatchLoss(newDispatch);

    // Auto-create/sync into ShopStock so that Shop has ready inventory immediately
    let shopStock = await ShopStock.findOne({
      storeName: { $regex: new RegExp(`^${(destinationStore || 'Main Shop').trim()}$`, 'i') },
      productType: { $regex: new RegExp(`^${readyStock.productType.trim()}$`, 'i') },
      packetSizeGrams: Number(readyStock.packetSizeGrams)
    });

    if (shopStock) {
      shopStock.totalPackets = (Number(shopStock.totalPackets) || 0) + packetsToDispatch;
      shopStock.totalWeightKg = Number(((Number(shopStock.totalWeightKg) || 0) + weightToDispatchKg).toFixed(2));
      shopStock.availablePackets = (Number(shopStock.availablePackets) || 0) + packetsToDispatch;
      shopStock.availableWeightKg = Number(((Number(shopStock.availableWeightKg) || 0) + weightToDispatchKg).toFixed(2));
      shopStock.costPerPacket = readyStock.costPerPacket || shopStock.costPerPacket || 0;
      shopStock.costPerKg = readyStock.costPerKg || (readyStock.packetSizeGrams > 0 ? (readyStock.costPerPacket * (1000 / readyStock.packetSizeGrams)) : shopStock.costPerKg || 0);
      shopStock.costPerGram = readyStock.costPerGram || ((shopStock.costPerKg || 0) / 1000);
      shopStock.dispatchId = newDispatch._id;
      shopStock.receivedDate = new Date();
      await shopStock.save();
    } else {
      const derivedCostKg = readyStock.costPerKg || (readyStock.packetSizeGrams > 0 ? (readyStock.costPerPacket * (1000 / readyStock.packetSizeGrams)) : 0);
      const derivedCostGm = readyStock.costPerGram || (derivedCostKg / 1000);
      await ShopStock.create({
        storeName: destinationStore || 'Main Shop',
        dispatchId: newDispatch._id,
        readyStockId: readyStock._id,
        productionBatchId: readyStock.productionBatchId,
        stockBatchId: readyStock.stockBatchId || '',
        productType: readyStock.productType,
        packetSizeGrams: readyStock.packetSizeGrams,
        totalPackets: packetsToDispatch,
        totalWeightKg: weightToDispatchKg,
        availablePackets: packetsToDispatch,
        availableWeightKg: weightToDispatchKg,
        costPerPacket: readyStock.costPerPacket || 0,
        costPerKg: derivedCostKg,
        costPerGram: derivedCostGm,
        costingUnit: readyStock.costingUnit || 'theli',
        receivedDate: new Date()
      });
    }

    res.status(201).json(newDispatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getDispatches = async (req, res) => {
  try {
    const dispatches = await PackagingDispatch.find().sort({ dispatchedAt: -1 });
    res.status(200).json(dispatches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getReadyStock = async (req, res) => {
  try {
    const stock = await ReadyStock.find({
      $or: [
        { availablePackets: { $gt: 0 } },
        { availableWeightKg: { $gt: 0 } }
      ]
    }).sort({ productionDate: -1 });
    res.status(200).json(stock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllReadyStock = async (req, res) => {
  try {
    const stock = await ReadyStock.find().sort({ productionDate: -1 });
    res.status(200).json(stock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getDispatchHistoryByReadyStock = async (req, res) => {
  try {
    const dispatches = await PackagingDispatch.find({ readyStockId: req.params.id }).sort({ dispatchedAt: -1 });
    res.status(200).json(dispatches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateReadyStock = async (req, res) => {
  try {
    const { availablePackets, availableWeightGrams, costPerKg, costPerPacket } = req.body;
    const stock = await ReadyStock.findById(req.params.id);
    if (!stock) return res.status(404).json({ message: 'Not found' });
    
    if (availablePackets !== undefined) stock.availablePackets = Number(availablePackets);
    if (availableWeightGrams !== undefined) {
      stock.availableWeightGrams = Number(availableWeightGrams);
      stock.availableWeightKg = Number((Number(availableWeightGrams) / 1000).toFixed(4));
    }
    if (costPerKg !== undefined && costPerKg !== '') {
      stock.costPerKg = Number(costPerKg);
      stock.costPerGram = Number(costPerKg) / 1000;
      if (!stock.costPerPacket || stock.costingUnit === 'kg') {
        stock.costPerPacket = Number(costPerKg) * (stock.packetSizeGrams / 1000);
      }
      if (stock.costing) {
        stock.costing.costPerKg = Number(costPerKg);
        stock.costing.costPerPacket = stock.costPerPacket;
      }
    }
    if (costPerPacket !== undefined && costPerPacket !== '') {
      stock.costPerPacket = Number(costPerPacket);
      if (stock.packetSizeGrams > 0) {
        stock.costPerKg = Number(costPerPacket) * (1000 / stock.packetSizeGrams);
        stock.costPerGram = stock.costPerKg / 1000;
      }
      if (stock.costing) {
        stock.costing.costPerPacket = Number(costPerPacket);
        stock.costing.costPerKg = stock.costPerKg;
      }
    }
    await stock.save();
    res.json(stock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteReadyStock = async (req, res) => {
  try {
    await ReadyStock.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateDispatch = async (req, res) => {
  try {
    const {
      packetsDispatched, weightDispatched, dispatchId,
      driverId, driverName, driverMobileNumber, tempoNumberPlate,
      driverRatePerKg, driverRateUnit, driverFreightTotal
    } = req.body;
    const PackagingDispatch = require('../models/PackagingDispatch');
    const Sale = require('../models/Sale');
    const LossEntry = require('../models/LossEntry');

    const dispatch = await PackagingDispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: 'Not found' });
    
    if (packetsDispatched !== undefined) dispatch.packetsDispatched = packetsDispatched;
    if (weightDispatched !== undefined) dispatch.weightDispatched = weightDispatched;
    if (driverId !== undefined) dispatch.driverId = driverId;
    if (driverName !== undefined) dispatch.driverName = driverName;
    if (driverMobileNumber !== undefined) dispatch.driverMobileNumber = driverMobileNumber;
    if (tempoNumberPlate !== undefined) dispatch.tempoNumberPlate = tempoNumberPlate;
    if (driverRatePerKg !== undefined) dispatch.driverRatePerKg = Number(driverRatePerKg) || 0;
    if (driverRateUnit !== undefined) dispatch.driverRateUnit = driverRateUnit;
    if (driverFreightTotal !== undefined) dispatch.driverFreightTotal = Number(driverFreightTotal) || 0;
    if (dispatchId && dispatchId.trim() !== dispatch.dispatchId) {
      const oldId = dispatch.dispatchId;
      const newId = dispatchId.trim();
      const existing = await PackagingDispatch.findOne({ dispatchId: newId, _id: { $ne: dispatch._id } });
      if (existing) {
        return res.status(400).json({ message: `Challan number "${newId}" already exists.` });
      }
      dispatch.dispatchId = newId;
      await Sale.updateMany(
        { 'items.challanId': oldId },
        { $set: { 'items.$[elem].challanId': newId } },
        { arrayFilters: [{ 'elem.challanId': oldId }] }
      );
      await LossEntry.updateMany(
        { refCode: oldId, refModel: 'PackagingDispatch' },
        { $set: { refCode: newId } }
      );
    }
    await dispatch.save();
    res.json(dispatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteDispatch = async (req, res) => {
  try {
    const dispatch = await PackagingDispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: 'Dispatch not found' });

    // Restore ReadyStock
    if (dispatch.readyStockId) {
      const readyStock = await ReadyStock.findById(dispatch.readyStockId);
      if (readyStock) {
        readyStock.availablePackets += dispatch.packetsToDispatch;
        readyStock.availableWeightKg += dispatch.weightToDispatchKg;
        readyStock.dispatchedPackets = Math.max(0, readyStock.dispatchedPackets - dispatch.packetsToDispatch);
        readyStock.dispatchedWeightKg = Math.max(0, readyStock.dispatchedWeightKg - dispatch.weightToDispatchKg);
        // Packets written off with this dispatch go back too
        const lost = (Number(dispatch.dispatchLoss?.wastageQty) || 0) + (Number(dispatch.dispatchLoss?.differenceQty) || 0);
        if (lost > 0) {
          const lostKg = (lost * dispatch.packetSizeGrams) / 1000;
          readyStock.availablePackets += lost;
          readyStock.availableWeightKg += lostKg;
          readyStock.lostPackets = Math.max(0, (readyStock.lostPackets || 0) - lost);
          readyStock.lostWeightKg = Math.max(0, (readyStock.lostWeightKg || 0) - lostKg);
        }
        await readyStock.save();
      }
    }

    // Remove synced ShopStock
    await ShopStock.deleteMany({ dispatchId: dispatch._id });

    await PackagingDispatch.findByIdAndDelete(req.params.id);
    await removeLoss(dispatch._id); // both dispatch and store-receive entries
    res.json({ message: 'Dispatch deleted and stock restored' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
