const mongoose = require('mongoose');
const lossSplitSchema = require('./lossSplitSchema');

const machineRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true },
  machineNumber: { type: String, required: true },
  stockId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
  stockBatchId: { type: String, required: true },
  productName: { type: String, required: true },
  plannedRawQuantity: { type: Number, required: true },
  rollType: { type: String, default: '' },
  mountedRolls: [{
    rollType: String,
    mountedAt: { type: Date, default: Date.now }
  }],
  plannedRollQuantity: { type: Number, default: 0 },
  actualRawConsumed: { type: Number, default: 0 },
  actualRollsConsumed: { type: Number, default: 0 },
  readyProductType: { type: String },
  packetSizeGrams: { type: Number },
  readyWeightKg: { type: Number, default: 0 },
  totalReadyPackets: { type: Number, default: 0 },
  wastageWeightKg: { type: Number, default: 0 },
  wastageReason: { type: String },
  differenceWeightKg: { type: Number, default: 0 },
  // Raw used vs ready weight, split into wastage and difference
  productionLoss: { type: lossSplitSchema, default: undefined },
  status: { type: String, enum: ['RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'], default: 'RUNNING' },
  // Every time the run is paused and resumed
  pauses: [{
    pausedAt: { type: Date, default: Date.now },
    resumedAt: { type: Date },
    reason: { type: String, default: '' }
  }],
  operatorName: { type: String, required: true },
  costingUnit: { type: String, enum: ['theli', 'kg', 'gram'], default: 'theli' },
  notes: { type: String },
  batchAllocations: [{
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock' },
    batchId: { type: String },
    quantity: { type: Number },
    purchaseRate: { type: Number }
  }],
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('MachineRun', machineRunSchema);
