const mongoose = require('mongoose');

// Advance (Upad) taken by staff before salary payout
const advanceSchema = new mongoose.Schema({
  advanceId: {
    type: String,
    required: true,
    unique: true
  },
  member: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TeamMember',
    required: true
  },
  advanceDate: {
    type: Date,
    default: Date.now
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  paymentMode: {
    type: String,
    enum: ['Cash', 'UPI', 'Bank Transfer', 'Other'],
    default: 'Cash'
  },
  paidFrom: {
    type: String,
    enum: ['Cash', 'Company Bank', 'Personal Bank'],
    default: 'Cash'
  },
  reason: {
    type: String,
    default: 'Upad'
  },
  status: {
    type: String,
    enum: ['Pending', 'Partially Deducted', 'Deducted'],
    default: 'Pending'
  },
  amountDeducted: {
    type: Number,
    default: 0
  },
  deductedInPayrolls: [
    {
      payroll: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll' },
      amount: Number,
      date: { type: Date, default: Date.now }
    }
  ],
  linkedExpenseId: {
    type: String,
    default: ''
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'Admin'
  }
}, { timestamps: true });

module.exports = mongoose.model('Advance', advanceSchema);
