const mongoose = require('mongoose');
const lossSplitSchema = require('./lossSplitSchema');

const purchaseSchema = new mongoose.Schema({
  purchaseId: {
    type: String,
    required: true,
    unique: true
  },
  supplier: {
    type: String,
    required: true
  },
  partyMobileNumber: {
    type: String,
    default: ''
  },
  purchaseDate: {
    type: Date,
    required: true
  },
  item: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  rate: {
    type: Number,
    required: true
  },
  totalPrice: {
    type: Number,
    required: true
  },
  // Costs added to each theli packed from this batch (₹ per theli)
  packagingCost: {
    type: Number,
    default: 0
  },
  transportCost: {
    type: Number,
    default: 0
  },
  otherCost: {
    type: Number,
    default: 0
  },
  driverName: {
    type: String,
    default: ''
  },
  driverMobileNumber: {
    type: String,
    default: ''
  },
  tempoNumber: {
    type: String,
    default: ''
  },
  fromAddress: {
    type: String,
    default: ''
  },
  toAddress: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed'],
    default: 'Pending'
  },
  receivedQuantity: {
    type: Number,
    default: null
  },
  wasteReason: {
    type: String,
    default: ''
  },
  // Ordered vs received, split into wastage and difference
  receiveLoss: { type: lossSplitSchema, default: undefined },
  // Damaged quantity already taken out of the stock batch (so edits only move the change)
  stockWastageQty: { type: Number, default: 0 },
  // Paid to the supplier so far (kept in sync by the finance payments)
  amountPaid: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Purchase', purchaseSchema);
