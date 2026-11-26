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
    const { machineNumber, stockId, productName, plannedRawQuantity, operatorName, notes } = req.body;

    const machine = await Machine.findOne({ code: String(machineNumber) });
    if (machine && !machine.isActive) return res.status(400).json({ message: `${machine.name} is turned off in Settings` });
    const busy = await MachineRun.findOne({ machineNumber: String(machineNumber), status: { $in: ACTIVE_STATUSES } });
    if (busy) return res.status(400).json({ message: `${machine ? machine.name : 'Machine ' + machineNumber} already has a run in progress (${busy.runId})` });

    // Find available stock batches (Product-wise)
    let targetStocks = [];
    if (productName) {
      targetStocks = await Stock.find({
        productName: new RegExp(`^${productName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        packagingGodownQuantity: { $gt: 0 }
      }).sort({ createdAt: 1 }); // FIFO order
    } else if (stockId) {
      const single = await Stock.findById(stockId);
      if (single) {
        targetStocks = await Stock.find({
          productName: new RegExp(`^${single.productName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          packagingGodownQuantity: { $gt: 0 }
        }).sort({ createdAt: 1 });
      }
    }

    if (targetStocks.length === 0) return res.status(404).json({ message: 'No available stock found for selected product' });

    // Validate quantities across available batches
    const totalAvailableRaw = targetStocks.reduce((sum, s) => sum + Math.max(0, s.packagingGodownQuantity - (s.packagingGodownReservedQuantity || 0)), 0);

    if (totalAvailableRaw < plannedRawQuantity) return res.status(400).json({ message: `Insufficient raw material in Godown. Available: ${totalAvailableRaw} KG` });

    // Allocate & reserve planned quantity across batches via FIFO
    let remainingToReserve = plannedRawQuantity;
    const batchAllocations = [];
    for (const s of targetStocks) {
      const free = Math.max(0, s.packagingGodownQuantity - (s.packagingGodownReservedQuantity || 0));
      if (free <= 0) continue;
      const take = Math.min(free, remainingToReserve);
      s.packagingGodownReservedQuantity = (s.packagingGodownReservedQuantity || 0) + take;
      await s.save();
      batchAllocations.push({
        stockId: s._id,
        batchId: s.batchId,
        quantity: take,
        purchaseRate: s.purchaseRate || 0
      });
      remainingToReserve -= take;
      if (remainingToReserve <= 0) break;
    }

    const primaryStock = targetStocks[0];
    const runId = `RUN-${Date.now()}`;
    const allBatchIds = batchAllocations.map(b => b.batchId).join(', ');

    const newRun = new MachineRun({
      runId,
      machineNumber,
      stockId: primaryStock._id,
      stockBatchId: allBatchIds || primaryStock.batchId,
      productName: primaryStock.productName,
      plannedRawQuantity,
      rollType: '',
      mountedRolls: [{ mountedAt: new Date() }],
      operatorName,
      costingUnit: primaryStock.costingUnit || 'theli',
      notes,
      batchAllocations,
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
    const runs = await MachineRun.find({ status: { $in: ACTIVE_STATUSES } }).populate('stockId', 'costingUnit').sort({ startTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRunHistory = async (req, res) => {
  try {
    const runs = await MachineRun.find({ status: { $nin: ACTIVE_STATUSES } }).populate('stockId', 'costingUnit').sort({ endTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRunHistoryByStock = async (req, res) => {
  try {
    const stockId = req.params.stockId;
    const runs = await MachineRun.find({
      $or: [
        { stockId: stockId },
        { 'batchAllocations.stockId': stockId }
      ],
      status: 'COMPLETED'
    }).sort({ endTime: -1 });
    res.status(200).json(runs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getRunHistoryByProduct = async (req, res) => {
  try {
    const productName = req.params.productName;
    const runs = await MachineRun.find({
      productName: new RegExp(`^${productName.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'i'),
      status: 'COMPLETED'
    }).sort({ endTime: -1 });
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

    // Check rolls across all batches of this product
    const targetStocks = await Stock.find({
      productName: new RegExp(`^${(run.productName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      packagingGodownQuantity: { $gt: 0 }
    });
    const totalRolls = targetStocks.reduce((a, s) => a + (Number(s.packagingRollQuantity) || 0), 0);
    const activeProductRuns = await MachineRun.find({
      productName: new RegExp(`^${(run.productName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      status: { $in: ACTIVE_STATUSES },
      _id: { $ne: run._id }
    });
    const onOthers = activeProductRuns.reduce((a, r) => a + (r.mountedRolls ? r.mountedRolls.length : 0), 0);
    const rollsAvailable = Math.max(0, totalRolls - onOthers);
    if (Number(actualRollsConsumed) > rollsAvailable && rollsAvailable > 0) {
      return res.status(400).json({ message: `Only ${rollsAvailable} rolls are available for ${run.productName}. You cannot use more.` });
    }

    closeOpenPause(run);

    const stock = await Stock.findById(run.stockId);
    const unit = req.body.costingUnit || stock?.costingUnit || run.costingUnit || 'theli';
    const isKg = (unit === 'kg');

    // Look up Product Setting for packet size and packets per KG
    const setting = await findSetting(readyProductType || run.productName, packetSizeGrams);
    const pSize = Number(packetSizeGrams) || (setting && setting.packetSizeGrams) || 200;
    const ppk = (setting && setting.packetsPerKg) || (pSize > 0 ? 1000 / pSize : 5);

    // Calculate packets: use provided totalReadyPackets if > 0, otherwise calculate from weight and packetsPerKg
    const totalReadyPackets = (req.body.totalReadyPackets !== undefined && req.body.totalReadyPackets !== null && req.body.totalReadyPackets !== '' && Number(req.body.totalReadyPackets) > 0)
      ? Number(req.body.totalReadyPackets)
      : Math.floor(readyWeightKg * ppk);
    
    // Deduct actuals from godown, release reservations
    if (run.batchAllocations && run.batchAllocations.length > 0) {
      // 1. Release all planned reservations
      for (const alloc of run.batchAllocations) {
        const s = await Stock.findById(alloc.stockId);
        if (s) {
          s.packagingGodownReservedQuantity = Math.max(0, (s.packagingGodownReservedQuantity || 0) - alloc.quantity);
          await s.save();
        }
      }
      // 2. Deduct actual raw consumed across batches via FIFO
      let remainingRaw = actualRawConsumed;
      for (const alloc of run.batchAllocations) {
        const s = await Stock.findById(alloc.stockId);
        if (s) {
          const deduct = Math.min(s.packagingGodownQuantity, remainingRaw);
          s.packagingGodownQuantity -= deduct;
          s.packagingGodownConsumedQuantity = (s.packagingGodownConsumedQuantity || 0) + deduct;
          remainingRaw -= deduct;
          await s.save();
          if (remainingRaw <= 0) break;
        }
      }
      if (remainingRaw > 0) {
        // If consumed more than planned, take from other batches of this product
        const moreStocks = await Stock.find({
          productName: new RegExp(`^${(run.productName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          packagingGodownQuantity: { $gt: 0 }
        }).sort({ createdAt: 1 });
        for (const s of moreStocks) {
          const deduct = Math.min(s.packagingGodownQuantity, remainingRaw);
          s.packagingGodownQuantity -= deduct;
          s.packagingGodownConsumedQuantity = (s.packagingGodownConsumedQuantity || 0) + deduct;
          remainingRaw -= deduct;
          await s.save();
          if (remainingRaw <= 0) break;
        }
      }
      // 3. Deduct rolls consumed
      let remainingRolls = actualRollsConsumed;
      for (const alloc of run.batchAllocations) {
        const s = await Stock.findById(alloc.stockId);
        if (s && s.packagingRollQuantity > 0) {
          const rDeduct = Math.min(s.packagingRollQuantity, remainingRolls);
          s.packagingRollQuantity -= rDeduct;
          s.packagingRollConsumedQuantity = (s.packagingRollConsumedQuantity || 0) + rDeduct;
          remainingRolls -= rDeduct;
          await s.save();
          if (remainingRolls <= 0) break;
        }
      }
    } else if (stock) {
      stock.packagingGodownQuantity -= actualRawConsumed;
      stock.packagingGodownReservedQuantity = Math.max(0, (stock.packagingGodownReservedQuantity || 0) - run.plannedRawQuantity);
      stock.packagingGodownConsumedQuantity = (stock.packagingGodownConsumedQuantity || 0) + actualRawConsumed;
      stock.packagingRollQuantity -= actualRollsConsumed;
      stock.packagingRollConsumedQuantity = (stock.packagingRollConsumedQuantity || 0) + actualRollsConsumed;
      await stock.save();
    }

    run.actualRawConsumed = actualRawConsumed;
    run.actualRollsConsumed = actualRollsConsumed;
    run.readyProductType = readyProductType;
    run.packetSizeGrams = pSize;
    run.readyWeightKg = readyWeightKg;
    run.totalReadyPackets = totalReadyPackets;
    run.productionLoss = loss.split;
    run.wastageWeightKg = loss.split.wastageQty;
    run.differenceWeightKg = loss.split.differenceQty;
    run.wastageReason = splitSummary(loss.split, 'KG');
    run.operatorName = operatorName;
    run.notes = notes;
    run.costingUnit = unit;
    run.status = 'COMPLETED';
    run.endTime = Date.now();
    await run.save();
    await syncProductionLoss(run);

    // Calculate raw rate: use weighted average if multiple batches were allocated
    let rawRate = stock ? stock.purchaseRate : 0;
    if (run.batchAllocations && run.batchAllocations.length > 0) {
      const totalRawAlloc = run.batchAllocations.reduce((a, b) => a + (Number(b.quantity) || 0), 0);
      if (totalRawAlloc > 0) {
        const totalRawSpend = run.batchAllocations.reduce((a, b) => a + (Number(b.quantity) || 0) * (Number(b.purchaseRate) || 0), 0);
        rawRate = Number((totalRawSpend / totalRawAlloc).toFixed(2));
      }
    }

    // Create Ready Stock, costed from this batch's purchase (rate, packaging, transport) and the product's settings
    const { costing, costPerPacket, costPerKg, costPerGram } = calcTheliCost({
      purchaseRate: rawRate,
      batchCosts: await batchCostsOf(stock),
      packetSizeGrams: pSize,
      rawConsumedKg: actualRawConsumed,
      totalPackets: totalReadyPackets,
      setting
    });

    let finalCostPerKg = costPerKg;
    let finalCostPerPacket = costPerPacket;
    let finalCostPerGram = costPerGram;

    // If user explicitly picked or customized the cost in Finish Machine modal:
    if (req.body.selectedCostPerKg !== undefined && req.body.selectedCostPerKg !== null && req.body.selectedCostPerKg !== '') {
      finalCostPerKg = Number(req.body.selectedCostPerKg);
      finalCostPerGram = Number((finalCostPerKg / 1000).toFixed(4));
      finalCostPerPacket = ppk > 0 ? Number((finalCostPerKg / ppk).toFixed(2)) : Number(((finalCostPerKg * pSize) / 1000).toFixed(2));
      if (costing) {
        costing.costPerKg = finalCostPerKg;
        costing.costPerPacket = finalCostPerPacket;
        costing.costPerGram = finalCostPerGram;
      }
    }

    // Each completed run creates its own Ready Stock production batch
    const readyStock = new ReadyStock({
      productType: readyProductType.trim(),
      packetSizeGrams: Number(pSize),
      totalPackets: totalReadyPackets,
      totalWeightKg: readyWeightKg,
      productionBatchId: `PB-${Date.now()}`,
      machineRunId: run._id,
      stockBatchId: run.stockBatchId,
      costPerPacket: finalCostPerPacket,
      costPerKg: finalCostPerKg,
      costPerGram: finalCostPerGram,
      costing,
      costingUnit: unit,
      availablePackets: totalReadyPackets,
      availableWeightKg: readyWeightKg,
      operatorName,
      productionDate: Date.now()
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

    if (run.batchAllocations && run.batchAllocations.length > 0) {
      for (const alloc of run.batchAllocations) {
        const s = await Stock.findById(alloc.stockId);
        if (s) {
          s.packagingGodownReservedQuantity = Math.max(0, (s.packagingGodownReservedQuantity || 0) - alloc.quantity);
          await s.save();
        }
      }
    } else {
      const stock = await Stock.findById(run.stockId);
      if (stock) {
        stock.packagingGodownReservedQuantity = Math.max(0, (stock.packagingGodownReservedQuantity || 0) - run.plannedRawQuantity);
        await stock.save();
      }
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
    
    if (run.status !== 'RUNNING') return res.status(400).json({ message: 'Resume the machine before loading a new roll' });

    const targetStocks = await Stock.find({
      productName: new RegExp(`^${(run.productName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      packagingGodownQuantity: { $gt: 0 }
    });
    const totalRolls = targetStocks.reduce((a, s) => a + (Number(s.packagingRollQuantity) || 0), 0);
    const activeRuns = await MachineRun.find({
      productName: new RegExp(`^${(run.productName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      status: { $in: ACTIVE_STATUSES }
    });
    let totalMounted = 0;
    activeRuns.forEach(r => {
      totalMounted += (r.mountedRolls ? r.mountedRolls.length : 0);
    });

    if (totalMounted >= totalRolls && totalRolls > 0) {
      return res.status(400).json({ message: `Cannot add roll. Only ${totalRolls} rolls are available in Godown for ${run.productName}.` });
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
    const { actualRawConsumed, actualReadyWeight, actualPackets, actualRollsConsumed } = req.body;
    const MachineRun = require('../models/MachineRun');
    const run = await MachineRun.findById(id);
    if (!run) return res.status(404).json({ message: 'Run not found' });

    const readyKg = actualReadyWeight !== undefined ? Number(actualReadyWeight) : run.readyWeightKg;
    const rawKg = actualRawConsumed !== undefined ? Number(actualRawConsumed) : run.actualRawConsumed;
    const pkts = actualPackets !== undefined ? Number(actualPackets) : run.totalReadyPackets;
    const rolls = actualRollsConsumed !== undefined ? Number(actualRollsConsumed) : run.actualRollsConsumed;

    if (run.status === 'COMPLETED') {
      const Stock = require('../models/Stock');
      const stock = await Stock.findById(run.stockId);
      if (stock) {
        const rawDiff = rawKg - (run.actualRawConsumed || 0);
        stock.packagingGodownQuantity -= rawDiff;
        stock.packagingGodownConsumedQuantity = (stock.packagingGodownConsumedQuantity || 0) + rawDiff;

        if (actualRollsConsumed !== undefined) {
          const rollDiff = rolls - (run.actualRollsConsumed || 0);
          stock.packagingRollQuantity -= rollDiff;
          stock.packagingRollConsumedQuantity = (stock.packagingRollConsumedQuantity || 0) + rollDiff;
        }

        await stock.save();
      }

      // Also update ReadyStock corresponding to this run
      const ReadyStock = require('../models/ReadyStock');
      const rs = await ReadyStock.findOne({ machineRunId: run._id });
      if (rs) {
        const weightDiff = readyKg - (run.readyWeightKg || 0);
        const packetDiff = pkts - (run.totalReadyPackets || 0);
        rs.totalWeightKg = Math.max(0, Number(((rs.totalWeightKg || 0) + weightDiff).toFixed(2)));
        rs.availableWeightKg = Math.max(0, Number(((rs.availableWeightKg || 0) + weightDiff).toFixed(2)));
        rs.totalPackets = Math.max(0, (rs.totalPackets || 0) + packetDiff);
        rs.availablePackets = Math.max(0, (rs.availablePackets || 0) + packetDiff);
        await rs.save();
      }
    }

    run.actualRawConsumed = rawKg;
    run.actualReadyWeight = readyKg;
    run.readyWeightKg = readyKg;
    run.actualPackets = pkts;
    run.totalReadyPackets = pkts;
    if (actualRollsConsumed !== undefined) {
      run.actualRollsConsumed = rolls;
    }

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
        if (run.batchAllocations && run.batchAllocations.length > 0) {
          for (const alloc of run.batchAllocations) {
            const s = await Stock.findById(alloc.stockId);
            if (s) {
              s.packagingGodownReservedQuantity = Math.max(0, (s.packagingGodownReservedQuantity || 0) - alloc.quantity);
              await s.save();
            }
          }
        } else {
          const reservedStock = await Stock.findById(run.stockId);
          if (reservedStock) {
              reservedStock.packagingGodownReservedQuantity = Math.max(0, (reservedStock.packagingGodownReservedQuantity || 0) - (run.plannedRawQuantity || 0));
              await reservedStock.save();
          }
        }
    }

    if(run.status === 'COMPLETED') {
        const Stock = require('../models/Stock');
        if (run.batchAllocations && run.batchAllocations.length > 0) {
          for (const alloc of run.batchAllocations) {
            const s = await Stock.findById(alloc.stockId);
            if (s) {
              s.packagingGodownQuantity += (alloc.quantity || 0);
              s.packagingGodownConsumedQuantity = Math.max(0, (s.packagingGodownConsumedQuantity || 0) - (alloc.quantity || 0));
              await s.save();
            }
          }
        } else {
          const stock = await Stock.findById(run.stockId);
          if(stock) {
              stock.packagingGodownQuantity += (run.actualRawConsumed || 0);
              stock.packagingGodownConsumedQuantity = Math.max(0, (stock.packagingGodownConsumedQuantity || 0) - (run.actualRawConsumed || 0));
              stock.packagingRollQuantity += (run.actualRollsConsumed || 0);
              stock.packagingRollConsumedQuantity = Math.max(0, (stock.packagingRollConsumedQuantity || 0) - (run.actualRollsConsumed || 0));
              await stock.save();
          }
        }
        const ReadyStock = require('../models/ReadyStock');
        await ReadyStock.deleteMany({ machineRunId: run._id });
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
