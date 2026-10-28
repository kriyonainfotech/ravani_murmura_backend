const PackagingRequest = require('../models/PackagingRequest');
const Stock = require('../models/Stock');
const { buildSplit, splitSummary, recordLoss, removeLoss } = require('../utils/lossLedger');

// Stage 2 of the loss ledger: sent from the shop vs received at the packaging unit
const syncTransferLoss = async (request) => {
  const common = {
    stage: 'GODOWN_TRANSFER', refModel: 'PackagingRequest', refId: request._id, refCode: request.requestId,
    productName: request.productName, stockBatchId: request.stockBatchId, party: request.toAddress || '',
    recordedBy: request.receivedBy || request.createdBy, entryDate: request.receivedAt
  };
  if (request.rawLoss) await recordLoss({ ...common, unit: 'KG', split: request.rawLoss });
  // Only track rolls when rolls were actually sent
  if (request.rollLoss && (request.rollLoss.expectedQty > 0 || request.rollLoss.actualQty > 0)) {
    await recordLoss({ ...common, unit: 'ROLL', split: request.rollLoss });
  }
};

exports.createDispatch = async (req, res) => {
  try {
    const {
      stockId,
      sentQuantity,
      packagingRollQuantity,
      driverName,
      driverMobileNumber,
      tempoNumberPlate,
      targetPanelId,
      fromAddress,
      toAddress,
      createdBy
    } = req.body;

    const stock = await Stock.findById(stockId);
    if (!stock) return res.status(404).json({ message: 'Stock not found' });
    
    if (stock.remainingQuantity < sentQuantity) {
      return res.status(400).json({ message: 'Insufficient stock quantity' });
    }

    const requestId = `PKG-REQ-${Date.now()}`;

    const newRequest = new PackagingRequest({
      requestId,
      stockId,
      stockBatchId: stock.batchId,
      productName: stock.productName,
      sentQuantity,
      packagingRollQuantity,
      driverName,
      driverMobileNumber,
      tempoNumberPlate,
      targetPanelId,
      fromAddress,
      toAddress,
      dispatchedAt: Date.now(),
      createdBy: (req.user && req.user.role !== 'super_admin' ? req.user.name : createdBy) || req.user?.name || 'Admin'
    });

    await newRequest.save();

    stock.remainingQuantity -= sentQuantity;
    stock.inTransitQuantity += sentQuantity;
    await stock.save();

    res.status(201).json(newRequest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRequests = async (req, res) => {
  try {
    let filter = {};
    if (req.query.panelId) {
      filter.targetPanelId = req.query.panelId;
    }
    const requests = await PackagingRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate('targetPanelId', 'name email');
    res.status(200).json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRequestById = async (req, res) => {
  try {
    const request = await PackagingRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    res.status(200).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.receiveRequest = async (req, res) => {
  try {
    const { shortageReason, rawLoss, rollLoss } = req.body;
    const receivedQuantity = Number(req.body.receivedQuantity) || 0;
    const receivedPackagingRollQuantity = Number(req.body.receivedPackagingRollQuantity) || 0;

    const request = await PackagingRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });

    if (request.status !== 'IN_TRANSIT') {
      return res.status(400).json({ message: 'Request is already received' });
    }

    // Split each gap into wastage and difference (old clients send one shortageReason for everything)
    const raw = buildSplit({
      expected: request.sentQuantity, actual: receivedQuantity, input: rawLoss,
      mode: 'received', unitLabel: 'KG', legacyReason: shortageReason
    });
    if (raw.error) return res.status(400).json({ message: `Raw material: ${raw.error}` });
    const rolls = buildSplit({
      expected: request.packagingRollQuantity || 0, actual: receivedPackagingRollQuantity, input: rollLoss,
      mode: 'received', unitLabel: 'rolls', legacyReason: shortageReason
    });
    if (rolls.error) return res.status(400).json({ message: `Packaging rolls: ${rolls.error}` });

    const shortageQuantity = request.sentQuantity - receivedQuantity;
    const shortageRollQuantity = (request.packagingRollQuantity || 0) - receivedPackagingRollQuantity;

    request.receivedQuantity = receivedQuantity;
    request.receivedPackagingRollQuantity = receivedPackagingRollQuantity;
    request.shortageQuantity = shortageQuantity;
    request.shortageRollQuantity = shortageRollQuantity;
    request.rawLoss = raw.split;
    request.rollLoss = rolls.split;
    request.shortageReason = [splitSummary(raw.split, 'KG'), splitSummary(rolls.split, 'rolls')].filter(Boolean).join(' | ');
    request.status = (shortageQuantity > 0 || shortageRollQuantity > 0) ? 'RECEIVED_WITH_SHORTAGE' : 'RECEIVED';
    request.receivedAt = Date.now();
    request.receivedBy = req.user?.name || '';

    await request.save();
    await syncTransferLoss(request);

    const stock = await Stock.findById(request.stockId);
    if (stock) {
      // Damaged material / rolls received are not usable, so they never enter the godown
      stock.inTransitQuantity -= request.sentQuantity;
      stock.packagingGodownQuantity += receivedQuantity - raw.split.wastageQty;
      stock.packagingRollQuantity += receivedPackagingRollQuantity - rolls.split.wastageQty;
      await stock.save();
    }

    res.status(200).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.deleteRequest = async (req, res) => {
  try {
    const request = await PackagingRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });

    const stock = await Stock.findById(request.stockId);
    if (stock) {
      if (request.status === 'IN_TRANSIT') {
        stock.inTransitQuantity -= request.sentQuantity;
        stock.remainingQuantity += request.sentQuantity;
      } else {
        // If it was already received
        stock.packagingGodownQuantity -= (request.receivedQuantity || 0) - (request.rawLoss?.wastageQty || 0);
        stock.packagingRollQuantity -= (request.receivedPackagingRollQuantity || 0) - (request.rollLoss?.wastageQty || 0);
        stock.remainingQuantity += request.sentQuantity;
      }
      await stock.save();
    }

    await PackagingRequest.findByIdAndDelete(req.params.id);
    await removeLoss(request._id);
    res.status(200).json({ message: 'Request deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getGodownStock = async (req, res) => {
  try {
    const stock = await Stock.find({ packagingGodownQuantity: { $gt: 0 } });
    res.status(200).json(stock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};




exports.getGodownHistory = async (req, res) => {
  try {
    const stock = await Stock.find({ 
      packagingGodownQuantity: { $lte: 0, $exists: true }, packagingGodownConsumedQuantity: { $gt: 0 }
    }).sort({ updatedAt: -1 });
    res.status(200).json(stock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

