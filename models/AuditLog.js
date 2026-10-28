const mongoose = require('mongoose');

// One row per create / update / delete made from the app.
// Written by utils/auditPlugin.js, never edited or deleted from the app.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, enum: ['CREATE', 'UPDATE', 'DELETE'], required: true },
  collectionName: { type: String, required: true },
  docId: { type: mongoose.Schema.Types.ObjectId },
  docCode: { type: String, default: '' }, // purchaseId / batchId / saleId ... whichever the doc has
  changes: [{
    _id: false,
    field: String,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed
  }],
  snapshot: { type: mongoose.Schema.Types.Mixed }, // full doc for deletes
  byName: { type: String, default: '' },
  byRole: { type: String, default: '' },
  byId: { type: String, default: '' },
  path: { type: String, default: '' },
  at: { type: Date, default: Date.now }
}, { versionKey: false });

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ docCode: 1 });
auditLogSchema.index({ collectionName: 1, at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
