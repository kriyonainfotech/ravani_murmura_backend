const { currentUser, requestContext } = require('./requestContext');

// Global mongoose plugin: every create / update / delete made while serving a
// logged-in request is written to AuditLog with old value, new value, who and when.
// Must be registered (mongoose.plugin) before any model is compiled.

const SKIP_MODELS = new Set(['AuditLog']);
// Sub-documents (sale items, loss splits) have no model of their own: their parent is logged
const skip = (modelName) => !modelName || SKIP_MODELS.has(modelName) || !currentUser();
const SKIP_FIELDS = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
const SECRET_FIELDS = new Set(['password']);
// Own code of the record first (a Stock also carries purchaseId, but as an ObjectId)
const CODE_FIELDS = ['batchId', 'requestId', 'runId', 'dispatchId', 'saleId', 'paymentId', 'expenseId', 'entryId',
  'productionBatchId', 'purchaseId', 'code', 'productName', 'name', 'email', 'key'];

const codeOf = (doc) => {
  if (!doc) return '';
  for (const f of CODE_FIELDS) if (typeof doc[f] === 'string' && doc[f]) return doc[f];
  return '';
};

const plain = (v) => {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && typeof v.toHexString === 'function') return v.toHexString();
  if (typeof v === 'object') return JSON.parse(JSON.stringify(v));
  return v;
};

// Field-level differences (nested objects and arrays compared as a whole)
const diff = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  keys.forEach(k => {
    if (SKIP_FIELDS.has(k)) return;
    const o = plain(before?.[k]);
    const n = plain(after?.[k]);
    if (JSON.stringify(o ?? null) === JSON.stringify(n ?? null)) return;
    const secret = SECRET_FIELDS.has(k);
    changes.push({ field: k, oldValue: secret ? '******' : o, newValue: secret ? '******' : n });
  });
  return changes;
};

const write = async (entry) => {
  const user = currentUser();
  if (!user) return; // scripts / startup backfills are not logged
  const store = requestContext.getStore() || {};
  try {
    const AuditLog = require('mongoose').model('AuditLog');
    await AuditLog.create({
      ...entry,
      byName: user.name || '',
      byRole: user.role || '',
      byId: String(user.id || ''),
      path: `${store.method || ''} ${store.path || ''}`.trim()
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
};

const stripSecrets = (doc) => {
  if (!doc) return doc;
  const copy = plain(doc);
  SECRET_FIELDS.forEach(f => { if (f in copy) copy[f] = '******'; });
  return copy;
};

module.exports = function auditPlugin(schema) {
  // Remember the doc as loaded, to diff against on save
  schema.post('init', function () {
    if (skip(this.constructor.modelName)) return;
    this.$locals.auditOriginal = this.toObject({ depopulate: true });
  });

  schema.pre('save', function () {
    this.$locals.auditWasNew = this.isNew;
  });

  schema.post('save', async function (doc) {
    const model = doc.constructor.modelName;
    if (skip(model)) return;
    const now = doc.toObject({ depopulate: true });
    if (doc.$locals.auditWasNew) {
      await write({ action: 'CREATE', collectionName: model, docId: doc._id, docCode: codeOf(now) });
    } else {
      const changes = diff(doc.$locals.auditOriginal || {}, now);
      if (changes.length) await write({ action: 'UPDATE', collectionName: model, docId: doc._id, docCode: codeOf(now), changes });
    }
    doc.$locals.auditOriginal = now;
  });

  schema.post('insertMany', async function (docs) {
    if (skip(this.modelName)) return;
    for (const d of docs || []) {
      await write({ action: 'CREATE', collectionName: this.modelName, docId: d._id, docCode: codeOf(d) });
    }
  });

  // ---- Query updates -------------------------------------------------------
  const UPDATE_OPS = ['findOneAndUpdate', 'updateOne', 'updateMany', 'findOneAndReplace', 'replaceOne'];
  schema.pre(UPDATE_OPS, { document: false, query: true }, async function () {
    if (skip(this.model.modelName)) return;
    const single = this.op !== 'updateMany';
    let q = this.model.find(this.getFilter()).lean();
    if (single) q = q.limit(1);
    this._auditBefore = await q;
  });
  schema.post(UPDATE_OPS, { document: false, query: true }, async function () {
    const before = this._auditBefore;
    if (!before || !before.length) return;
    const after = await this.model.find({ _id: { $in: before.map(b => b._id) } }).lean();
    for (const b of before) {
      const a = after.find(x => String(x._id) === String(b._id));
      const changes = diff(b, a || {});
      if (changes.length) {
        await write({ action: 'UPDATE', collectionName: this.model.modelName, docId: b._id, docCode: codeOf(a || b), changes });
      }
    }
  });

  // ---- Query deletes -------------------------------------------------------
  const DELETE_OPS = ['findOneAndDelete', 'deleteOne', 'deleteMany'];
  schema.pre(DELETE_OPS, { document: false, query: true }, async function () {
    if (skip(this.model.modelName)) return;
    let q = this.model.find(this.getFilter()).lean();
    if (this.op !== 'deleteMany') q = q.limit(1);
    this._auditBefore = await q;
  });
  schema.post(DELETE_OPS, { document: false, query: true }, async function () {
    for (const b of this._auditBefore || []) {
      await write({ action: 'DELETE', collectionName: this.model.modelName, docId: b._id, docCode: codeOf(b), snapshot: stripSecrets(b) });
    }
  });

  // doc.deleteOne()
  schema.post('deleteOne', { document: true, query: false }, async function (doc) {
    const model = doc.constructor.modelName;
    if (skip(model)) return;
    await write({ action: 'DELETE', collectionName: model, docId: doc._id, docCode: codeOf(doc), snapshot: stripSecrets(doc.toObject({ depopulate: true })) });
  });
};
