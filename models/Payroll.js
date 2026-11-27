const mongoose = require('mongoose');

const payrollPaymentSchema = new mongoose.Schema({
  paymentId: { type: String, default: '' },
  paymentDate: { type: Date, default: Date.now },
  amount: { type: Number, required: true, min: 0.01 },
  paidFrom: { type: String, enum: ['Cash', 'Company Bank', 'Personal Bank'], default: 'Cash' },
  paymentMode: { type: String, default: 'Cash' },
  reference: { type: String, default: '' },
  linkedExpenseId: { type: String, default: '' },
  notes: { type: String, default: '' },
  createdBy: { type: String, default: 'Admin' }
}, { timestamps: true });

const payrollSchema = new mongoose.Schema({
  payrollId: {
    type: String,
    required: true,
    unique: true
  },
  member: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TeamMember',
    required: true
  },
  month: {
    type: String, // 'YYYY-MM'
    required: true
  },
  monthLabel: {
    type: String, // e.g. 'November 2026'
    default: ''
  },
  salaryType: {
    type: String,
    enum: ['Monthly', 'Daily'],
    default: 'Monthly'
  },
  baseSalary: {
    type: Number,
    required: true,
    default: 0
  },
  totalDaysInMonth: {
    type: Number,
    default: 30
  },
  presentDays: {
    type: Number,
    default: 0
  },
  halfDays: {
    type: Number,
    default: 0
  },
  absentDays: {
    type: Number,
    default: 0
  },
  paidLeaveDays: {
    type: Number,
    default: 0
  },
  overtimeHours: {
    type: Number,
    default: 0
  },
  overtimePay: {
    type: Number,
    default: 0
  },
  grossEarned: {
    type: Number,
    default: 0
  },
  bonus: {
    type: Number,
    default: 0
  },
  advanceDeducted: {
    type: Number,
    default: 0
  },
  manualAdvanceDeduction: {
    type: Boolean,
    default: false
  },
  otherDeductions: {
    type: Number,
    default: 0
  },
  netPayable: {
    type: Number,
    default: 0
  },
  amountPaid: {
    type: Number,
    default: 0
  },
  balanceDue: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['Unpaid', 'Partial', 'Paid'],
    default: 'Unpaid'
  },
  payments: [payrollPaymentSchema],
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'Admin'
  }
}, { timestamps: true });

payrollSchema.index({ member: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', payrollSchema);
