const mongoose = require('mongoose');

const driverAdvanceSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  paymentMode: { type: String, default: 'Cash' }, // Cash, UPI, Bank Transfer
  paidFrom: { type: String, default: '' },
  reference: { type: String, default: '' },
  notes: { type: String, default: '' },
  givenBy: { type: String, default: 'Admin' },
  createdAt: { type: Date, default: Date.now }
});

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    default: '',
    trim: true
  },
  vehicleNumber: {
    type: String,
    default: '',
    trim: true,
    uppercase: true
  },
  vehicleType: {
    type: String,
    default: 'Tempo',
    trim: true
  },
  defaultRatePerKg: {
    type: Number,
    default: 0
  },
  rateUnit: {
    type: String,
    enum: ['rupee', 'paise'],
    default: 'rupee'
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  notes: {
    type: String,
    default: ''
  },
  advances: [driverAdvanceSchema],
  createdBy: {
    type: String,
    default: 'Super Admin'
  }
}, { timestamps: true });

module.exports = mongoose.model('Driver', driverSchema);
