const mongoose = require('mongoose');

const readyStockSchema = new mongoose.Schema({
  productType: { type: String, required: true },
  packetSizeGrams: { type: Number, required: true },
  totalPackets: { type: Number, default: 0 },
  totalWeightKg: { type: Number, default: 0 },
  productionBatchId: { type: String, required: true, unique: true },
  machineRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'MachineRun', required: true },
  stockBatchId: { type: String },
  costPerPacket: { type: Number, default: 0 },
  // How costPerPacket was built up (all values per theli)
  costing: {
    purchaseRate: { type: Number, default: 0 },
    packetsPerKg: { type: Number, default: 0 },
    rawCost: { type: Number, default: 0 },
    packagingCost: { type: Number, default: 0 },
    transportCost: { type: Number, default: 0 },
    otherCost: { type: Number, default: 0 },
    wastageCost: { type: Number, default: 0 },
    spreadWastage: { type: Boolean, default: false }
  },
  availablePackets: { type: Number, default: 0 },
  availableWeightKg: { type: Number, default: 0 },
  dispatchedPackets: { type: Number, default: 0 },
  dispatchedWeightKg: { type: Number, default: 0 },
  // Packets written off at dispatch (damaged / missing)
  lostPackets: { type: Number, default: 0 },
  lostWeightKg: { type: Number, default: 0 },
  operatorName: { type: String, required: true },
  productionDate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('ReadyStock', readyStockSchema);
