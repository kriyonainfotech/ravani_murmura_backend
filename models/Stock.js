const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  batchId: {
    type: String,
    required: true,
    unique: true
  },
  purchaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  supplier: {
    type: String,
    required: true
  },
  purchaseDate: {
    type: Date,
    required: true
  },
  purchaseRate: {
    type: Number,
    required: true
  },
  purchasedQuantity: {
    type: Number,
    required: true
  },
  remainingQuantity: {
    type: Number,
    required: true
  },
  inTransitQuantity: {
    type: Number,
    default: 0
  },
  packagingGodownQuantity: {
    type: Number,
    default: 0
  },
  packagingGodownReservedQuantity: {
    type: Number,
    default: 0
  },
  packagingRollQuantity: {
    type: Number,
    default: 0
  },
  packagingRollReservedQuantity: {
    type: Number,
    default: 0
  },
  
  packagingGodownConsumedQuantity: {
    type: Number,
    default: 0
  },
  packagingRollConsumedQuantity: {
    type: Number,
    default: 0
  },
  location: {

    type: String,
    enum: ["Shop", "In Transit", "Packaging Godown", "In Machine", "Ready", "Returned"],
    default: "Shop"
  },
  status: {
    type: String,
    default: "Available"
  },
  createdBy: {
    type: String,
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Stock', stockSchema);
