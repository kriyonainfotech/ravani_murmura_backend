const mongoose = require('mongoose');

const shopStockSchema = new mongoose.Schema({
  storeName: {
    type: String,
    required: true,
    default: 'Main Shop'
  },
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store'
  },
  dispatchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PackagingDispatch'
  },
  readyStockId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ReadyStock'
  },
  productionBatchId: {
    type: String,
    required: true
  },
  stockBatchId: {
    type: String,
    default: ''
  },
  productType: {
    type: String,
    required: true
  },
  packetSizeGrams: {
    type: Number,
    required: true
  },
  totalPackets: {
    type: Number,
    required: true,
    default: 0
  },
  totalWeightKg: {
    type: Number,
    required: true,
    default: 0
  },
  availablePackets: {
    type: Number,
    required: true,
    default: 0
  },
  availableWeightKg: {
    type: Number,
    required: true,
    default: 0
  },
  costPerPacket: {
    type: Number,
    default: 0
  },
  costPerKg: {
    type: Number,
    default: 0
  },
  costPerGram: {
    type: Number,
    default: 0
  },
  costingUnit: {
    type: String,
    enum: ['theli', 'kg', 'gram'],
    default: 'theli'
  },
  receivedDate: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('ShopStock', shopStockSchema);
