const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  member: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TeamMember',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  dateStr: {
    type: String, // 'YYYY-MM-DD'
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['Present', 'Half Day', 'Absent', 'Paid Leave'],
    default: 'Present'
  },
  dayValue: {
    type: Number,
    default: 1.0 // 1.0 for Present / Paid Leave, 0.5 for Half Day, 0 for Absent
  },
  overtimeHours: {
    type: Number,
    default: 0,
    min: 0
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

// Ensure unique record per team member per calendar day
attendanceSchema.index({ member: 1, dateStr: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
