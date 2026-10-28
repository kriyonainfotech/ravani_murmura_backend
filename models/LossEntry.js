const mongoose = require('mongoose');

// One row per stage event (purchase receive, godown transfer, machine run, dispatch, store receive).
// The gap between expected and actual is split into wastage (material physically lost / damaged)
// and difference (weight or count mismatch). Reports and admin approvals read from here.
const lossEntrySchema = new mongoose.Schema({
  entryId: { type: String, required: true, unique: true },
  stage: {
    type: String,
    enum: ['PURCHASE_RECEIVE', 'GODOWN_TRANSFER', 'MACHINE_PRODUCTION', 'DISPATCH', 'STORE_RECEIVE'],
    required: true
  },
  unit: { type: String, enum: ['KG', 'THELI', 'ROLL'], default: 'KG' },

  // Source document
  refModel: { type: String },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true },
  refCode: { type: String, default: '' },

  productName: { type: String, default: '' },
  stockBatchId: { type: String, default: '' },
  packetSizeGrams: { type: Number, default: 0 },
  party: { type: String, default: '' }, // supplier / store / machine, whichever fits the stage

  expectedQty: { type: Number, default: 0 },
  actualQty: { type: Number, default: 0 },
  wastageQty: { type: Number, default: 0 },
  wastageReason: { type: String, default: '' },
  wastageNote: { type: String, default: '' },
  differenceQty: { type: Number, default: 0 }, // negative = more than expected
  differenceReason: { type: String, default: '' },
  differenceNote: { type: String, default: '' },

  // Same numbers in KG so stages can be compared (rolls have no weight → 0)
  expectedKg: { type: Number, default: 0 },
  wastageKg: { type: Number, default: 0 },
  differenceKg: { type: Number, default: 0 },

  wastagePct: { type: Number, default: 0 },
  differencePct: { type: Number, default: 0 },
  // Allowed quantity per entry (in `unit`) at the time it was saved
  limitWastageQty: { type: Number, default: 0 },
  limitDifferenceQty: { type: Number, default: 0 },
  overLimit: { type: Boolean, default: false },

  approvalStatus: {
    type: String,
    enum: ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'],
    default: 'NOT_REQUIRED'
  },
  approvalRemark: { type: String, default: '' },
  approvedBy: { type: String, default: '' },
  approvedAt: { type: Date },

  recordedBy: { type: String, default: '' },
  photo: { type: String, default: '' }, // compressed JPEG data URL (optional proof)
  photoBy: { type: String, default: '' },
  entryDate: { type: Date, default: Date.now }
}, { timestamps: true });

lossEntrySchema.index({ stage: 1, refId: 1, unit: 1 }, { unique: true });
lossEntrySchema.index({ entryDate: -1 });
lossEntrySchema.index({ approvalStatus: 1 });

module.exports = mongoose.model('LossEntry', lossEntrySchema);
