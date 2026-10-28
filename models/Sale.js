const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  productionBatchId: { type: String, default: '' },
  stockBatchId: { type: String, default: '' },
  packetSizeGrams: { type: Number, required: true },
  quantityTheli: { type: Number, required: true },
  weightKg: { type: Number, required: true },
  rateType: { type: String, enum: ['theli', 'kg'], default: 'theli' },
  sellingRate: { type: Number, required: true }, // Rate per theli or per kg depending on rateType
  costPerPacket: { type: Number, default: 0 },
  itemAmount: { type: Number, required: true },
  itemCost: { type: Number, default: 0 },
  itemProfit: { type: Number, default: 0 },
  inventorySourceId: { type: mongoose.Schema.Types.ObjectId },
  inventoryType: { type: String, enum: ['ReadyStock', 'ShopStock'], default: 'ReadyStock' },
  challanId: { type: String, default: '' },
  storeName: { type: String, default: '' }
});

const saleSchema = new mongoose.Schema({
  saleId: {
    type: String,
    required: true,
    unique: true
  },
  saleDate: {
    type: Date,
    default: Date.now
  },
  sellFrom: {
    type: String,
    enum: ['Packaging Godown', 'Shop'],
    required: true,
    default: 'Shop'
  },
  customerName: {
    type: String,
    default: 'Walk-in Customer'
  },
  customerMobile: {
    type: String,
    default: ''
  },
  customerAddress: {
    type: String,
    default: ''
  },
  items: [saleItemSchema],
  totalTheli: {
    type: Number,
    required: true,
    default: 0
  },
  totalWeightKg: {
    type: Number,
    required: true,
    default: 0
  },
  subTotal: {
    type: Number,
    required: true,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  finalAmount: {
    type: Number,
    required: true,
    default: 0
  },
  totalCost: {
    type: Number,
    default: 0
  },
  totalProfit: {
    type: Number,
    default: 0
  },
  paymentMode: {
    type: String,
    enum: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Credit', 'Other'],
    default: 'Cash'
  },
  paymentStatus: {
    type: String,
    enum: ['Paid', 'Pending', 'Partial'],
    default: 'Paid'
  },
  // Money received so far (kept in sync by the finance payments). null = old bill, read from paymentStatus
  amountPaid: {
    type: Number,
    default: null
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Sale', saleSchema);
