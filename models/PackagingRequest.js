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
  driverName: { type: String },
  driverMobileNumber: { type: String },
  tempoNumberPlate: { type: String },
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
