
const mongoose = require('mongoose');

const productSettingSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  packetSizeGrams: { type: Number, required: true },
  packetsPerKg: { type: Number, required: true },
  defaultSellingRate: { type: Number, default: 0 },
  // Spread raw material lost in the machine over the ready theli
  spreadWastage: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('ProductSetting', productSettingSchema);
