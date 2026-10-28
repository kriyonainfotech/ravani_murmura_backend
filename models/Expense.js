const mongoose = require('mongoose');

// Money going out of the business. Category 'Purchase' is linked to a purchase bill and counts as paid on it.
const expenseSchema = new mongoose.Schema({
  expenseId: { type: String, required: true, unique: true },
  expenseDate: { type: Date, default: Date.now },
  amount: { type: Number, required: true, min: 0.01 },
  paidFrom: { type: String, enum: ['Cash', 'Company Bank', 'Personal Bank'], default: 'Cash' },
  category: { type: String, required: true, trim: true },
  purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
  billNo: { type: String, default: '' }, // purchaseId when linked
  paidTo: { type: String, default: '' }, // supplier / employee / shop
  description: { type: String, default: '' },
  reference: { type: String, default: '' }, // UPI ref / cheque no
  createdBy: { type: String, default: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('Expense', expenseSchema);
