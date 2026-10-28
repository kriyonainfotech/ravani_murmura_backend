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

exports.createReadyDispatch = async (req, res) => {
  try {
    const { 
      readyStockId, packetsToDispatch, destinationStore, destinationAddress, fromAddress,
      driverName, driverMobileNumber, tempoNumberPlate, notes, preparedBy,
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

    const dispatchId = `CHALLAN-${Date.now()}`;
    
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
      driverName,
      driverMobileNumber,
      tempoNumberPlate,
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
      receivedDate: new Date()
    });

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
    const stock = await ReadyStock.find({ availablePackets: { $gt: 0 } }).sort({ productionDate: -1 });
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
    const { availablePackets, availableWeightGrams } = req.body;
    const stock = await ReadyStock.findById(req.params.id);
    if (!stock) return res.status(404).json({ message: 'Not found' });
    
    stock.availablePackets = availablePackets;
    stock.availableWeightGrams = availableWeightGrams;
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
    const { packetsDispatched, weightDispatched } = req.body;
    const PackagingDispatch = require('../models/PackagingDispatch');
    const dispatch = await PackagingDispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: 'Not found' });
    
    dispatch.packetsDispatched = packetsDispatched;
    dispatch.weightDispatched = weightDispatched;
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
