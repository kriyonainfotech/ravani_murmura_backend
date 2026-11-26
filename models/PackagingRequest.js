const mongoose = require('mongoose');
const lossSplitSchema = require('./lossSplitSchema');

const packagingRequestSchema = new mongoose.Schema({
  requestId: { type: String, required: true, unique: true },
  stockId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stock', required: true },
  targetPanelId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackagingPanel' },
  stockBatchId: { type: String },
  productName: { type: String },
  sentQuantity: { type: Number },
  receivedQuantity: { type: Number },
  packagingRollQuantity: { type: Number },
  receivedPackagingRollQuantity: { type: Number },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
  driverName: { type: String, default: '' },
  driverMobileNumber: { type: String, default: '' },
  tempoNumberPlate: { type: String, default: '' },
  driverRatePerKg: { type: Number, default: 0 },
  driverRateUnit: { type: String, enum: ['rupee', 'paise'], default: 'rupee' },
  driverFreightTotal: { type: Number, default: 0 },
  driverAdvance: { type: Number, default: 0 },
  fromAddress: { type: String },
  toAddress: { type: String },
  status: { type: String, enum: ['IN_TRANSIT', 'RECEIVED', 'RECEIVED_WITH_SHORTAGE'], default: 'IN_TRANSIT' },
  shortageQuantity: { type: Number },
  shortageRollQuantity: { type: Number },
  shortageReason: { type: String },
  // Sent vs received, split into wastage and difference (raw KG and rolls)
  rawLoss: { type: lossSplitSchema, default: undefined },
  rollLoss: { type: lossSplitSchema, default: undefined },
  dispatchedAt: { type: Date },
  receivedAt: { type: Date },
  receivedBy: { type: String, default: '' },
  createdBy: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('PackagingRequest', packagingRequestSchema);
