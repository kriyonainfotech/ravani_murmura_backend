const mongoose = require('mongoose');
const lossSplitSchema = require('./lossSplitSchema');

const packagingDispatchSchema = new mongoose.Schema({
  dispatchId: { type: String, required: true, unique: true },
  readyStockId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReadyStock', required: true },
  productionBatchId: { type: String, required: true },
  stockBatchId: { type: String },
  productType: { type: String, required: true },
  packetSizeGrams: { type: Number, required: true },
  packetsToDispatch: { type: Number, required: true },
  weightToDispatchKg: { type: Number, required: true },
  destinationStore: { type: String, required: true },
  destinationAddress: { type: String },
  // Transport details are optional (the form fills them from the last dispatch)
  driverName: { type: String, default: '' },
  driverMobileNumber: { type: String },
  tempoNumberPlate: { type: String, default: '' },
  fromAddress: { type: String },
  notes: { type: String },
  wastageKg: { type: Number, default: 0 },
  wastageReason: { type: String, default: '' },
  // Packets found damaged / missing while loading (taken out of ready stock, not sent)
  dispatchLoss: { type: lossSplitSchema, default: undefined },
  // What the store actually received
  receivedPackets: { type: Number },
  receiveLoss: { type: lossSplitSchema, default: undefined },
  status: { type: String, enum: ['PREPARED', 'DISPATCHED', 'DELIVERED', 'RECEIVED'], default: 'DISPATCHED' },
  dispatchedAt: { type: Date, default: Date.now },
  preparedBy: { type: String, required: true },
  isReceivedAtShop: { type: Boolean, default: false },
  receivedAt: { type: Date },
  receivedBy: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('PackagingDispatch', packagingDispatchSchema);
