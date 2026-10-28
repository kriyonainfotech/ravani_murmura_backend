const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
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
    default: 'store'
  }
}, { timestamps: true });

module.exports = mongoose.model('Store', storeSchema);
