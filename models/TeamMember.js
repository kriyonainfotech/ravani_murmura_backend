const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
  employeeId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    trim: true,
    default: ''
  },
  role: {
    type: String,
    trim: true,
    default: 'Worker'
  },
  department: {
    type: String,
    trim: true,
    default: 'General'
  },
  salaryType: {
    type: String,
    enum: ['Monthly', 'Daily'],
    default: 'Monthly'
  },
  baseSalary: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  joiningDate: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  bankDetails: {
    accountNo: { type: String, default: '' },
    ifsc: { type: String, default: '' },
    upiId: { type: String, default: '' },
    bankName: { type: String, default: '' }
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

module.exports = mongoose.model('TeamMember', teamMemberSchema);
