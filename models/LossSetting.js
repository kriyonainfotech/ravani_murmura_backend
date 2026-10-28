const mongoose = require('mongoose');

// Single settings document: allowed wastage / difference quantity per stage and whether
// over-limit entries need admin approval. Missing stages fall back to the defaults in utils/lossLedger.
const lossSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  approvalEnabled: { type: Boolean, default: true },
  // { PURCHASE_RECEIVE: { wastageQty: 5, differenceQty: 5 }, GODOWN_TRANSFER: { ..., rollWastageQty, rollDifferenceQty } }
  limits: { type: Object, default: {} },
  reasons: { type: Object, default: {} } // { STAGE: { wastage: [..], difference: [..] } }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('LossSetting', lossSettingSchema);
