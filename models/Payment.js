const mongoose = require('mongoose');

// Collection: money received from a customer against a sale bill.
// (Money going out is kept in Expense; supplier payments are Expenses with category 'Purchase'.)
const paymentSchema = new mongoose.Schema({
  paymentId: { type: String, required: true, unique: true },
  type: { type: String, enum: ['IN'], default: 'IN' },
  sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
  billNo: { type: String, default: '' }, // saleId shown in lists
  partyName: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.01 },
  mode: {
    type: String,
    enum: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'],
    default: 'Cash'
  },
  // Where the money landed
  account: { type: String, enum: ['Cash', 'Company Bank', 'Personal Bank'], default: 'Cash' },
  paymentDate: { type: Date, default: Date.now },
  reference: { type: String, default: '' }, // UPI ref / cheque no
  notes: { type: String, default: '' },
  createdBy: { type: String, default: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
