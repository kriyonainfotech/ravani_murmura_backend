const MachineRun = require('../models/MachineRun');
const Stock = require('../models/Stock');
const ReadyStock = require('../models/ReadyStock');
const Machine = require('../models/Machine');
const { findSetting, batchCostsOf, calcTheliCost } = require('../utils/costing');
const { buildSplit, resplit, splitSummary, recordLoss, removeLoss } = require('../utils/lossLedger');

// Stage 3 of the loss ledger: raw material used vs ready weight packed
const syncProductionLoss = async (run) => {
  if (!run.productionLoss) return;
  await recordLoss({
    stage: 'MACHINE_PRODUCTION', unit: 'KG', refModel: 'MachineRun', refId: run._id, refCode: run.runId,
    productName: run.productName, stockBatchId: run.stockBatchId, party: `Machine ${run.machineNumber}`,
    split: run.productionLoss, recordedBy: run.operatorName, entryDate: run.endTime
  });
};

// A run is "active" while it is running or paused
const ACTIVE_STATUSES = ['RUNNING', 'PAUSED'];

// Close an open pause (used on resume / complete / cancel)
const closeOpenPause = (run) => {
  const last = run.pauses && run.pauses[run.pauses.length - 1];
  if (last && !last.resumedAt) last.resumedAt = new Date();
};

exports.startMachine = async (req, res) => {
  try {
    const { machineNumber, stockId, plannedRawQuantity, operatorName, notes } = req.body;

    const machine = await Machine.findOne({ code: String(machineNumber) });
    if (machine && !machine.isActive) return res.status(400).json({ message: `${machine.name} is turned off in Settings` });
    const busy = await MachineRun.findOne({ machineNumber: String(machineNumber), status: { $in: ACTIVE_STATUSES } });
    if (busy) return res.status(400).json({ message: `${machine ? machine.name : 'Machine ' + machineNumber} already has a run in progress (${busy.runId})` });

    const stock = await Stock.findById(stockId);
    if (!stock) return res.status(404).json({ message: 'Stock not found' });

    // Validate quantities
    const availableRaw = stock.packagingGodownQuantity - (stock.packagingGodownReservedQuantity || 0);

    if (availableRaw < plannedRawQuantity) return res.status(400).json({ message: 'Insufficient raw material in Godown' });

    stock.packagingGodownReservedQuantity = (stock.packagingGodownReservedQuantity || 0) + plannedRawQuantity;
    await stock.save();

    const runId = `RUN-${Date.now()}`;

    const newRun = new MachineRun({
      runId,
      machineNumber,
      stockId,
      stockBatchId: stock.batchId,
      productName: stock.productName,
      plannedRawQuantity,
      rollType: '',
      mountedRolls: [{ mountedAt: new Date() }],
      operatorName,
      notes,
      status: 'RUNNING'
    });

    await newRun.save();
    res.status(201).json(newRun);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getActiveRuns = async (req, res) => {
  try {
    const runs = await MachineRun.find({ status: { $in: ACTIVE_STATUSES } }).sort({ startTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRunHistory = async (req, res) => {
  try {
    const runs = await MachineRun.find({ status: { $nin: ACTIVE_STATUSES } }).sort({ endTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRunHistoryByStock = async (req, res) => {
  try {
    const runs = await MachineRun.find({ stockId: req.params.stockId, status: 'COMPLETED' }).sort({ endTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.completeRun = async (req, res) => {
  try {
    const { 
      actualRawConsumed, actualRollsConsumed, readyProductType, packetSizeGrams, 
      readyWeightKg, wastageWeightKg, wastageReason, operatorName, notes 
    } = req.body;
    
    const run = await MachineRun.findById(req.params.id);
    if (!run) return res.status(404).json({ message: 'Run not found' });
    if (!ACTIVE_STATUSES.includes(run.status)) return res.status(400).json({ message: 'Run is not active' });
    // Raw used vs ready weight → wastage + difference (old clients send the whole gap as wastage)
    const loss = buildSplit({
      expected: actualRawConsumed, actual: readyWeightKg,
      input: req.body.loss || { wastageQty: wastageWeightKg, wastageReason },
      unitLabel: 'KG'
    });
    if (loss.error) return res.status(400).json({ message: loss.error });

    // Rolls used cannot be more than the batch has (minus rolls loaded on its other running machines)
    const rollStock = await Stock.findById(run.stockId);
    if (rollStock) {
      const others = await MachineRun.find({ stockId: run.stockId, status: { $in: ACTIVE_STATUSES }, _id: { $ne: run._id } });
      const onOthers = others.reduce((a, r) => a + (r.mountedRolls ? r.mountedRolls.length : 0), 0);
      const rollsAvailable = Math.max(0, (Number(rollStock.packagingRollQuantity) || 0) - onOthers);
      if (Number(actualRollsConsumed) > rollsAvailable) {
        return res.status(400).json({ message: `Only ${rollsAvailable} rolls are available for this batch. You cannot use more.` });
      }
    }

    closeOpenPause(run);

    // Calculate packets
    const totalReadyPackets = req.body.totalReadyPackets || Math.floor((readyWeightKg * 1000) / packetSizeGrams);
    
    const stock = await Stock.findById(run.stockId);
    
    // Deduct actuals from godown, release reservations
    if (stock) {
      stock.packagingGodownQuantity -= actualRawConsumed;
      stock.packagingGodownReservedQuantity -= run.plannedRawQuantity; // release planned
      stock.packagingGodownConsumedQuantity = (stock.packagingGodownConsumedQuantity || 0) + actualRawConsumed;
      
      stock.packagingRollQuantity -= actualRollsConsumed;
      stock.packagingRollConsumedQuantity = (stock.packagingRollConsumedQuantity || 0) + actualRollsConsumed;
      
      await stock.save();
    }

    run.actualRawConsumed = actualRawConsumed;
    run.actualRollsConsumed = actualRollsConsumed;
    run.readyProductType = readyProductType;
    run.packetSizeGrams = packetSizeGrams;
    run.readyWeightKg = readyWeightKg;
    run.totalReadyPackets = totalReadyPackets;
    run.productionLoss = loss.split;
    run.wastageWeightKg = loss.split.wastageQty;
    run.differenceWeightKg = loss.split.differenceQty;
    run.wastageReason = splitSummary(loss.split, 'KG');
    run.operatorName = operatorName;
    run.notes = notes;
    run.status = 'COMPLETED';
    run.endTime = Date.now();
    await run.save();
    await syncProductionLoss(run);

    // Create Ready Stock, costed from this batch's purchase (rate, packaging, transport) and the product's settings
    const setting = await findSetting(readyProductType, packetSizeGrams);
    const { costing, costPerPacket } = calcTheliCost({
      purchaseRate: stock ? stock.purchaseRate : 0,
      batchCosts: await batchCostsOf(stock),
      packetSizeGrams,
      rawConsumedKg: actualRawConsumed,
      totalPackets: totalReadyPackets,
      setting
    });

    const readyStock = new ReadyStock({
      productType: readyProductType,
      packetSizeGrams,
      totalPackets: totalReadyPackets,
      totalWeightKg: readyWeightKg,
      productionBatchId: `PB-${Date.now()}`,
      machineRunId: run._id,
      stockBatchId: run.stockBatchId,
      costPerPacket,
      costing,
      availablePackets: totalReadyPackets,
      availableWeightKg: readyWeightKg,
      operatorName
    });
    
    await readyStock.save();

    res.status(200).json({ run, readyStock });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.cancelRun = async (req, res) => {
  try {
    const run = await MachineRun.findById(req.params.id);
    if (!run) return res.status(404).json({ message: 'Run not found' });
    if (!ACTIVE_STATUSES.includes(run.status)) return res.status(400).json({ message: 'Only active runs can be cancelled' });
    closeOpenPause(run);

    const stock = await Stock.findById(run.stockId);
    if (stock) {
      stock.packagingGodownReservedQuantity -= run.plannedRawQuantity;
      await stock.save();
    }

    run.status = 'CANCELLED';
    run.endTime = Date.now();
    await run.save();

    res.status(200).json(run);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.mountRoll = async (req, res) => {
  try {
    const { id } = req.params;
    const run = await MachineRun.findById(id);
    if (!run) return res.status(404).json({ message: 'Machine run not found' });
    
    const Stock = require('../models/Stock');
    const stock = await Stock.findById(run.stockId);
    
    if (run.status !== 'RUNNING') return res.status(400).json({ message: 'Resume the machine before loading a new roll' });

    const activeRuns = await MachineRun.find({ stockId: run.stockId, status: { $in: ACTIVE_STATUSES } });
    let totalMounted = 0;
    activeRuns.forEach(r => {
      totalMounted += (r.mountedRolls ? r.mountedRolls.length : 0);
    });

    if (totalMounted >= stock.packagingRollQuantity) {
      return res.status(400).json({ message: `Cannot add roll. Only ${stock.packagingRollQuantity} rolls are available in Godown for this batch.` });
    }
    
    // Push the new roll
    run.mountedRolls.push({ mountedAt: new Date() });
    
    await run.save();
    res.json({ message: 'Roll mounted successfully', run });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.updateRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { actualRawConsumed, actualReadyWeight, actualPackets } = req.body;
    const MachineRun = require('../models/MachineRun');
    const run = await MachineRun.findById(id);
    if (!run) return res.status(404).json({ message: 'Run not found' });

    if(run.status === 'COMPLETED') {
        const Stock = require('../models/Stock');
        const stock = await Stock.findById(run.stockId);
        if(stock) {
            const rawDiff = Number(actualRawConsumed) - (run.actualRawConsumed || 0);
            stock.packagingGodownQuantity -= rawDiff;
            stock.packagingGodownConsumedQuantity = (stock.packagingGodownConsumedQuantity || 0) + rawDiff;
            await stock.save();
        }
    }

    run.actualRawConsumed = actualRawConsumed;
    run.actualReadyWeight = actualReadyWeight;
    run.actualPackets = actualPackets;
    if (run.status === 'COMPLETED') {
      // Raw used changed: keep the recorded wastage, the difference takes up the change
      run.productionLoss = resplit(run.productionLoss || { wastageQty: run.wastageWeightKg, wastageReason: run.wastageReason },
        Number(run.actualRawConsumed) || 0, Number(run.readyWeightKg) || 0);
      run.wastageWeightKg = run.productionLoss.wastageQty;
      run.differenceWeightKg = run.productionLoss.differenceQty;
      run.wastageReason = splitSummary(run.productionLoss, 'KG');
    }
    await run.save();
    await syncProductionLoss(run);
    res.json(run);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteRun = async (req, res) => {
  try {
    const { id } = req.params;
    const MachineRun = require('../models/MachineRun');
    const run = await MachineRun.findById(id);
    if (!run) return res.status(404).json({ message: 'Run not found' });

    // An unfinished run still holds reserved raw material — release it
    if (ACTIVE_STATUSES.includes(run.status)) {
        const reservedStock = await Stock.findById(run.stockId);
        if (reservedStock) {
            reservedStock.packagingGodownReservedQuantity = Math.max(0, (reservedStock.packagingGodownReservedQuantity || 0) - (run.plannedRawQuantity || 0));
            await reservedStock.save();
        }
    }

    if(run.status === 'COMPLETED') {
        const Stock = require('../models/Stock');
        const stock = await Stock.findById(run.stockId);
        if(stock) {
            stock.packagingGodownQuantity += (run.actualRawConsumed || 0);
            stock.packagingGodownConsumedQuantity = Math.max(0, (stock.packagingGodownConsumedQuantity || 0) - (run.actualRawConsumed || 0));
            stock.packagingRollQuantity += (run.actualRollsConsumed || 0);
            stock.packagingRollConsumedQuantity = Math.max(0, (stock.packagingRollConsumedQuantity || 0) - (run.actualRollsConsumed || 0));
            await stock.save();
        }
    }
    
    await MachineRun.findByIdAndDelete(id);
    await removeLoss(run._id);
    res.json({ message: 'Run deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};



exports.pauseRun = async (req, res) => {
  try {
    const run = await MachineRun.findById(req.params.id);
    if (!run) return res.status(404).json({ message: 'Run not found' });
    if (run.status !== 'RUNNING') return res.status(400).json({ message: 'Only a running machine can be paused' });

    run.pauses.push({ pausedAt: new Date(), reason: (req.body && req.body.reason) || '' });
    run.status = 'PAUSED';
    await run.save();
    res.json(run);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.resumeRun = async (req, res) => {
  try {
    const run = await MachineRun.findById(req.params.id);
    if (!run) return res.status(404).json({ message: 'Run not found' });
    if (run.status !== 'PAUSED') return res.status(400).json({ message: 'This run is not paused' });

    closeOpenPause(run);
    run.status = 'RUNNING';
    await run.save();
    res.json(run);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
