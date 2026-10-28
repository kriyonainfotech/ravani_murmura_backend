const Stock = require('../models/Stock');
const PackagingRequest = require('../models/PackagingRequest');
const MachineRun = require('../models/MachineRun');
const ReadyStock = require('../models/ReadyStock');
const PackagingDispatch = require('../models/PackagingDispatch');
const LossEntry = require('../models/LossEntry');

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// Rolls of one batch: Pending / Running / Finished. On an active run every
// mounted roll except the last one is already used up.
const rollStatus = (stock, activeRuns) => {
  const total = (Number(stock.packagingRollQuantity) || 0) + (Number(stock.packagingRollConsumedQuantity) || 0);
  let finished = Number(stock.packagingRollConsumedQuantity) || 0;
  let running = 0;
  activeRuns.forEach(r => {
    const mounted = (r.mountedRolls || []).length;
    if (mounted > 0) { running += 1; finished += mounted - 1; }
  });
  finished = Math.min(finished, total);
  running = Math.min(running, Math.max(0, total - finished));
  return { total, finished, running, pending: Math.max(0, total - finished - running) };
};

exports.getMasterTracking = async (req, res) => {
  try {
    const stocks = await Stock.find().populate('purchaseId').sort({ createdAt: -1 });
    const [activeRuns, doneRuns, losses] = await Promise.all([
      MachineRun.find({ status: { $in: ['RUNNING', 'PAUSED'] } }).lean(),
      MachineRun.find({ status: 'COMPLETED' }).select('stockId readyWeightKg').lean(),
      LossEntry.find({ unit: 'KG', stage: { $in: ['PURCHASE_RECEIVE', 'GODOWN_TRANSFER', 'MACHINE_PRODUCTION'] } })
        .select('stockBatchId wastageKg differenceKg').lean()
    ]);
    
    let summary = {
      totalPurchased: 0,
      mainGodown: 0,
      inTransit: 0,
      packagingGodown: 0,
      inMachine: 0,
      consumed: 0,
      readyStock: 0,
      dispatched: 0
    };

    let batches = [];

    for (let stock of stocks) {
      // 1. Core Stock Metrics
      summary.totalPurchased += (stock.purchasedQuantity || 0);
      summary.mainGodown += (stock.remainingQuantity || 0);
      summary.inTransit += (stock.inTransitQuantity || 0);
      summary.packagingGodown += (stock.packagingGodownQuantity || 0);
      summary.inMachine += (stock.packagingGodownReservedQuantity || 0);
      summary.consumed += (stock.packagingGodownConsumedQuantity || 0);

      // 2. Fetch associated Ready Stock for this batch
      // ReadyStock links to MachineRun, and MachineRun links to Stock batchId.
      // But actually, ReadyStock has productionBatchId which might be different. Let's just aggregate all ReadyStock.
      
      let batchData = {
        batchId: stock.batchId,
        productName: stock.productName,
        purchased: stock.purchasedQuantity || 0,
        mainGodown: stock.remainingQuantity || 0,
        inTransit: stock.inTransitQuantity || 0,
        packagingGodown: stock.packagingGodownQuantity || 0,
        inMachine: stock.packagingGodownReservedQuantity || 0,
        consumed: stock.packagingGodownConsumedQuantity || 0,
        readyStock: 0,
        dispatched: 0,
        createdAt: stock.createdAt
      };

      // Batch rule: Input kg = Ready kg + Waste kg + Difference kg (+ what is still in the pipeline).
      // Anything left over has no reason recorded; the batch closes only when that is zero.
      const billedKg = Number(stock.purchaseId?.quantity) || Number(stock.purchasedQuantity) || 0;
      const pipelineKg = (stock.remainingQuantity || 0) + (stock.inTransitQuantity || 0) + (stock.packagingGodownQuantity || 0);
      const readyKg = doneRuns.filter(r => String(r.stockId) === String(stock._id)).reduce((a, r) => a + (r.readyWeightKg || 0), 0);
      const batchLoss = losses.filter(l => l.stockBatchId === stock.batchId);
      const wasteKg = batchLoss.reduce((a, l) => a + (l.wastageKg || 0), 0);
      const differenceKg = batchLoss.reduce((a, l) => a + (l.differenceKg || 0), 0);
      const unexplainedKg = r3(billedKg - pipelineKg - readyKg - wasteKg - differenceKg);
      const balance = {
        inputKg: r3(billedKg), pipelineKg: r3(pipelineKg), readyKg: r3(readyKg),
        wasteKg: r3(wasteKg), differenceKg: r3(differenceKg), unexplainedKg,
        status: Math.abs(unexplainedKg) >= 0.01 ? 'UNEXPLAINED' : pipelineKg > 0.001 ? 'OPEN' : 'CLOSED'
      };

      const batchRuns = activeRuns.filter(r => String(r.stockId) === String(stock._id));
      Object.assign(batchData, {
        purchaseRate: stock.purchaseRate || 0,
        purchaseDate: stock.purchaseDate,
        location: stock.location,
        balance,
        rolls: rollStatus(stock, batchRuns)
      });
      
      batches.push(batchData);
    }

    // Aggregate ReadyStock
    const readyStocks = await ReadyStock.find().populate('machineRunId');
    for (let rs of readyStocks) {
      summary.readyStock += (rs.availableWeightKg || 0);
      summary.dispatched += (rs.dispatchedWeightKg || 0);
      
      // Attempt to link back to batch
      if (rs.machineRunId && rs.machineRunId.stockBatchId) {
        let b = batches.find(x => x.batchId === rs.machineRunId.stockBatchId);
        if (b) {
          b.readyStock += (rs.availableWeightKg || 0);
          b.dispatched += (rs.dispatchedWeightKg || 0);
        }
      }
    }

    // Machine live: which roll is running, which batch and which rate is inside
    const machines = activeRuns.map(r => {
      const b = batches.find(x => x.batchId === r.stockBatchId);
      const rolls = b?.rolls || { total: 0, finished: 0 };
      const mounted = (r.mountedRolls || []).length;
      return {
        runId: r.runId, machineNumber: r.machineNumber, status: r.status, operatorName: r.operatorName, startTime: r.startTime,
        stockBatchId: r.stockBatchId, productName: r.productName, purchaseRate: b?.purchaseRate || 0,
        plannedRawQuantity: r.plannedRawQuantity,
        rollNo: mounted > 0 ? Math.min(rolls.finished + 1, rolls.total || 1) : 0, rollTotal: rolls.total
      };
    });
    const unexplained = batches.filter(b => b.balance.status === 'UNEXPLAINED').length;

    res.json({
      success: true,
      summary,
      batches,
      machines,
      unexplained
    });
  } catch (error) {
    console.error('Master Tracking Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tracking data', error: error.message });
  }
};

exports.updateBatch = async (req, res) => {
  try {
    const { batchId } = req.params;
    const { mainGodown, inTransit, packagingGodown, inMachine } = req.body;
    
    const stock = await Stock.findOne({ batchId });
    if (!stock) return res.status(404).json({ success: false, message: 'Batch not found' });
    
    if (mainGodown !== undefined) stock.remainingQuantity = mainGodown;
    if (inTransit !== undefined) stock.inTransitQuantity = inTransit;
    if (packagingGodown !== undefined) stock.packagingGodownQuantity = packagingGodown;
    if (inMachine !== undefined) stock.packagingGodownReservedQuantity = inMachine;
    
    await stock.save();
    res.json({ success: true, message: 'Batch updated successfully' });
  } catch (error) {
    console.error('Update Batch Error:', error);
    res.status(500).json({ success: false, message: 'Failed to update batch' });
  }
};

exports.deleteBatch = async (req, res) => {
  try {
    const { batchId } = req.params;
    await Stock.findOneAndDelete({ batchId });
    // Note: We are just deleting the stock, keeping purchase history intact
    res.json({ success: true, message: 'Batch deleted successfully' });
  } catch (error) {
    console.error('Delete Batch Error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete batch' });
  }
};
