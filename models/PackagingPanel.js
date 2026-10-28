const mongoose = require('mongoose');

const packagingPanelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  mobileNumber: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  role: {
    type: String,
    default: 'packaging'
  }
}, { timestamps: true });

module.exports = mongoose.model('PackagingPanel', packagingPanelSchema);
