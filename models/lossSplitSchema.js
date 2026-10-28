const mongoose = require('mongoose');

// Wastage / difference split stored on each source document (purchase, transfer, run, dispatch)
const lossSplitSchema = new mongoose.Schema({
  expectedQty: { type: Number, default: 0 },
  actualQty: { type: Number, default: 0 },
  wastageQty: { type: Number, default: 0 },
  wastageReason: { type: String, default: '' },
  wastageNote: { type: String, default: '' },
  differenceQty: { type: Number, default: 0 },
  differenceReason: { type: String, default: '' },
  differenceNote: { type: String, default: '' }
}, { _id: false });

module.exports = lossSplitSchema;
