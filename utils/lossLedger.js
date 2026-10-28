const LossEntry = require('../models/LossEntry');
const LossSetting = require('../models/LossSetting');
const { requestContext } = require('./requestContext');

// ---- Stage definitions -------------------------------------------------------
// `unit` is the unit the stage's limit is set in
const STAGES = [
  { key: 'PURCHASE_RECEIVE', no: 1, label: 'Purchase Receive', flow: 'Supplier → Shop godown', unit: 'KG' },
  { key: 'GODOWN_TRANSFER', no: 2, label: 'Godown Transfer', flow: 'Shop → Packaging unit', unit: 'KG', hasRolls: true },
  { key: 'MACHINE_PRODUCTION', no: 3, label: 'Machine Production', flow: 'Raw material → Ready theli', unit: 'KG' },
  { key: 'DISPATCH', no: 4, label: 'Store Dispatch', flow: 'Ready stock → Tempo', unit: 'THELI' },
  { key: 'STORE_RECEIVE', no: 5, label: 'Store Receive', flow: 'Tempo → Store', unit: 'THELI' }
];
const STAGE_KEYS = STAGES.map(s => s.key);

// Wastage = material physically lost / damaged. Difference = weight or count mismatch.
const REASONS = {
  PURCHASE_RECEIVE: {
    wastage: ['Damaged / torn bags', 'Wet / moisture damaged', 'Spillage while unloading', 'Dust / impurity rejected', 'Other'],
    difference: ['Supplier short supply', 'Weighing scale difference', 'Moisture / weight loss', 'Extra received', 'Other']
  },
  GODOWN_TRANSFER: {
    wastage: ['Spilled during transport', 'Damaged bags', 'Damaged rolls', 'Wet in transit', 'Other'],
    difference: ['Weight difference on scale', 'Less loaded at godown', 'Missing bag / roll', 'Counting mistake', 'Other']
  },
  MACHINE_PRODUCTION: {
    wastage: ['Machine jam', 'Sealing failure', 'Spillage', 'Broken pieces sieved out', 'Roll damaged', 'Other'],
    difference: ['Moisture / weight loss', 'Packet over-fill / under-fill', 'Weighing difference', 'Loose stock left in machine', 'Other']
  },
  DISPATCH: {
    wastage: ['Torn / damaged packets', 'Sealing opened', 'Crushed while loading', 'Wet packets', 'Other'],
    difference: ['Count mismatch in ready stock', 'Packets missing', 'Entry mistake', 'Other']
  },
  STORE_RECEIVE: {
    wastage: ['Damaged in transit', 'Torn packets', 'Crushed / wet packets', 'Other'],
    difference: ['Short received / missing', 'Count mismatch', 'Extra received', 'Other']
  }
};

// Allowed wastage / difference per entry, in the stage unit (KG or packets).
// Godown transfer also carries rolls, which get their own limit.
const DEFAULT_LIMITS = {
  PURCHASE_RECEIVE: { wastageQty: 5, differenceQty: 5 },
  GODOWN_TRANSFER: { wastageQty: 2, differenceQty: 2, rollWastageQty: 1, rollDifferenceQty: 1 },
  MACHINE_PRODUCTION: { wastageQty: 10, differenceQty: 5 },
  DISPATCH: { wastageQty: 2, differenceQty: 1 },
  STORE_RECEIVE: { wastageQty: 2, differenceQty: 1 }
};
const LIMIT_FIELDS = (k) => Object.keys(DEFAULT_LIMITS[k]);

// Limit that applies to one entry (rolls use the roll limit of the stage)
const limitFor = (limits, stage, unit) => {
  const l = limits[stage] || {};
  if (unit === 'ROLL') return { wastageQty: l.rollWastageQty ?? 0, differenceQty: l.rollDifferenceQty ?? 0 };
  return { wastageQty: l.wastageQty ?? 0, differenceQty: l.differenceQty ?? 0 };
};

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Settings ----------------------------------------------------------------
const getSettings = async () => {
  let doc = await LossSetting.findOne({ key: 'default' }).lean();
  if (!doc) doc = { approvalEnabled: true, limits: {}, reasons: {} };
  const limits = {};
  STAGE_KEYS.forEach(k => {
    // Old % limits are ignored — they fall back to the default quantities
    const saved = (doc.limits && doc.limits[k]) || {};
    limits[k] = {};
    LIMIT_FIELDS(k).forEach(f => {
      limits[k][f] = saved[f] != null ? Number(saved[f]) : DEFAULT_LIMITS[k][f];
    });
  });
  return { approvalEnabled: doc.approvalEnabled !== false, limits, reasons: reasonsFrom(doc.reasons) };
};

// Reason masters: the admin's saved lists, falling back to the defaults above.
// "Other" always stays last so a free-text note is always possible.
const cleanList = (list) => {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach(r => {
    const t = String(r || '').trim().slice(0, 60);
    if (!t || t.toLowerCase() === 'other' || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  });
  return [...out, 'Other'];
};
const reasonsFrom = (saved = {}) => {
  const out = {};
  STAGE_KEYS.forEach(k => {
    out[k] = {
      wastage: saved?.[k]?.wastage ? cleanList(saved[k].wastage) : REASONS[k].wastage,
      difference: saved?.[k]?.difference ? cleanList(saved[k].difference) : REASONS[k].difference
    };
  });
  return out;
};

const saveSettings = async ({ approvalEnabled, limits, reasons }) => {
  const current = await getSettings();
  const nextReasons = { ...current.reasons };
  if (reasons) {
    STAGE_KEYS.forEach(k => {
      if (!reasons[k]) return;
      nextReasons[k] = {
        wastage: reasons[k].wastage ? cleanList(reasons[k].wastage) : nextReasons[k].wastage,
        difference: reasons[k].difference ? cleanList(reasons[k].difference) : nextReasons[k].difference
      };
    });
  }
  const next = { ...current.limits };
  if (limits) {
    STAGE_KEYS.forEach(k => {
      if (!limits[k]) return;
      next[k] = { ...next[k] };
      LIMIT_FIELDS(k).forEach(f => {
        const n = Number(limits[k][f]);
        if (limits[k][f] !== '' && limits[k][f] != null && Number.isFinite(n) && n >= 0) next[k][f] = n;
      });
    });
  }
  await LossSetting.findOneAndUpdate(
    { key: 'default' },
    { key: 'default', limits: next, reasons: nextReasons, approvalEnabled: approvalEnabled !== undefined ? !!approvalEnabled : current.approvalEnabled },
    { upsert: true, new: true }
  );
  return getSettings();
};

// ---- Split validation --------------------------------------------------------
const reasonError = (label, reason, note) => {
  if (!String(reason || '').trim()) return `${label} reason is required`;
  if (reason === 'Other' && !String(note || '').trim()) return `Please describe the ${label.toLowerCase()} reason`;
  return '';
};

/**
 * Turn user input into a wastage / difference split.
 *
 * mode 'received' : difference = expected - received (always the full gap); wastage = part of what was
 *                   received that turned out damaged, so usable = received - wastage (receive stages)
 * mode 'gap'      : gap = expected - actual is fixed; user gives wastage, difference = gap - wastage (machine)
 * mode 'direct'   : user gives both wastage and difference (dispatch: packets found bad while loading)
 *
 * `legacyReason` keeps old clients working: the whole gap becomes difference with that reason.
 * Returns { split } or { error }.
 */
const buildSplit = ({ expected, actual, input, mode = 'gap', unitLabel = '', legacyReason, requireReasons = true }) => {
  const exp = r3(expected);
  const inp = input || {};
  rememberPhoto(inp.photo, unitLabel);
  const wastageQty = r3(Math.max(0, Number(inp.wastageQty) || 0));
  let differenceQty;
  let act;

  if (mode === 'received') {
    act = r3(actual);
    if (wastageQty > Math.max(0, act)) return { error: `Wastage cannot be more than the received ${act} ${unitLabel}` };
    differenceQty = r3(exp - act);
  } else if (mode === 'direct') {
    differenceQty = r3(Math.max(0, Number(inp.differenceQty) || 0));
    act = r3(exp - wastageQty - differenceQty);
    if (act < 0) return { error: `Wastage + difference is more than ${exp} ${unitLabel}` };
  } else {
    act = r3(actual);
    const gap = r3(exp - act);
    if (wastageQty > Math.max(0, gap)) {
      return { error: gap > 0 ? `Wastage cannot be more than the total gap of ${gap} ${unitLabel}` : 'Nothing is short, so wastage must be 0' };
    }
    differenceQty = r3(gap - wastageQty);
  }

  const split = {
    expectedQty: exp,
    actualQty: act,
    wastageQty,
    wastageReason: wastageQty > 0 ? String(inp.wastageReason || '').trim() : '',
    wastageNote: wastageQty > 0 ? String(inp.wastageNote || '').trim() : '',
    differenceQty,
    differenceReason: differenceQty !== 0 ? String(inp.differenceReason || (!input ? legacyReason : '') || '').trim() : '',
    differenceNote: differenceQty !== 0 ? String(inp.differenceNote || '').trim() : ''
  };

  if (requireReasons) {
    if (split.wastageQty > 0) {
      const e = reasonError('Wastage', split.wastageReason, split.wastageNote);
      if (e) return { error: e };
    }
    if (split.differenceQty !== 0) {
      const e = reasonError('Difference', split.differenceReason, split.differenceNote);
      if (e) return { error: e };
    }
  }
  return { split };
};

// Keep the user's wastage when only the quantities were edited later and recompute the difference
const resplit = (oldSplit, expected, actual, mode = 'gap') => {
  const prev = oldSplit || {};
  const gap = r3(expected - actual);
  const maxWastage = mode === 'received' ? Math.max(0, actual) : Math.max(0, gap);
  const wastageQty = r3(Math.min(maxWastage, Number(prev.wastageQty) || 0));
  const differenceQty = mode === 'received' ? gap : r3(gap - wastageQty);
  return {
    expectedQty: r3(expected),
    actualQty: r3(actual),
    wastageQty,
    wastageReason: wastageQty > 0 ? prev.wastageReason || '' : '',
    wastageNote: wastageQty > 0 ? prev.wastageNote || '' : '',
    differenceQty,
    differenceReason: differenceQty !== 0 ? prev.differenceReason || '' : '',
    differenceNote: differenceQty !== 0 ? prev.differenceNote || '' : ''
  };
};

// One-line text for the old free-text reason fields still shown in some screens
const splitSummary = (split, unit = '') => {
  if (!split) return '';
  const parts = [];
  const why = (r, n) => [r, n].filter(Boolean).join(' – ');
  if (split.wastageQty > 0) parts.push(`Wastage ${split.wastageQty} ${unit}: ${why(split.wastageReason, split.wastageNote)}`.trim());
  if (split.differenceQty !== 0) parts.push(`Difference ${split.differenceQty} ${unit}: ${why(split.differenceReason, split.differenceNote)}`.trim());
  return parts.join(' | ');
};

// ---- Ledger ------------------------------------------------------------------
const kgFactor = (unit, packetSizeGrams) => {
  if (unit === 'KG') return 1;
  if (unit === 'THELI') return (Number(packetSizeGrams) || 0) / 1000;
  return 0; // rolls are counted, not weighed
};

/**
 * Create or update the ledger row for one stage event.
 * Approval is re-evaluated only when the numbers change, so an approved entry stays approved
 * if someone just re-saves the same values. Pass `autoApprove` for imported old records.
 */
// Optional photo sent with a stage form (input.photo). The split itself is stored on the
// stage document without it, so the photo waits in the request context until recordLoss
// writes the ledger entry of the same unit in the same request.
const UNIT_OF_LABEL = { KG: 'KG', kg: 'KG', rolls: 'ROLL', packets: 'THELI' };
const rememberPhoto = (photo, unitLabel) => {
  if (!photo || typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 4 * 1024 * 1024) return;
  const store = requestContext.getStore();
  if (!store) return;
  store.lossPhotos = store.lossPhotos || {};
  store.lossPhotos[UNIT_OF_LABEL[unitLabel] || 'KG'] = photo;
};
const takePhoto = (unit) => {
  const photos = requestContext.getStore()?.lossPhotos;
  if (!photos || !photos[unit]) return '';
  const p = photos[unit];
  delete photos[unit];
  return p;
};

const recordLoss = async ({
  stage, unit = 'KG', refModel, refId, refCode = '', productName = '', stockBatchId = '',
  packetSizeGrams = 0, party = '', split, recordedBy = '', entryDate, autoApprove = false
}) => {
  if (!refId || !split) return null;
  const settings = await getSettings();
  const limit = limitFor(settings.limits, stage, unit);
  const exp = Number(split.expectedQty) || 0;
  const wastagePct = exp > 0 ? r2((split.wastageQty / exp) * 100) : 0;
  const differencePct = exp > 0 ? r2((Math.abs(split.differenceQty) / exp) * 100) : 0;
  const overLimit = split.wastageQty > limit.wastageQty || Math.abs(split.differenceQty) > limit.differenceQty;
  const f = kgFactor(unit, packetSizeGrams);

  const values = {
    stage, unit, refModel, refId, refCode, productName, stockBatchId,
    packetSizeGrams: Number(packetSizeGrams) || 0, party,
    expectedQty: split.expectedQty, actualQty: split.actualQty,
    wastageQty: split.wastageQty, wastageReason: split.wastageReason, wastageNote: split.wastageNote,
    differenceQty: split.differenceQty, differenceReason: split.differenceReason, differenceNote: split.differenceNote,
    expectedKg: r3(exp * f), wastageKg: r3(split.wastageQty * f), differenceKg: r3(split.differenceQty * f),
    wastagePct, differencePct,
    limitWastageQty: limit.wastageQty, limitDifferenceQty: limit.differenceQty,
    overLimit
  };
  if (entryDate) values.entryDate = entryDate;
  if (recordedBy) values.recordedBy = recordedBy;
  const photo = takePhoto(unit);
  if (photo) { values.photo = photo; values.photoBy = recordedBy || ''; }

  const existing = await LossEntry.findOne({ stage, refId, unit });
  const numbersChanged = !existing
    || existing.expectedQty !== values.expectedQty
    || existing.wastageQty !== values.wastageQty
    || existing.differenceQty !== values.differenceQty;

  if (numbersChanged) {
    const needsApproval = settings.approvalEnabled && overLimit;
    if (needsApproval && autoApprove) {
      Object.assign(values, { approvalStatus: 'APPROVED', approvalRemark: 'Old record – auto-approved on import', approvedBy: 'System', approvedAt: new Date() });
    } else {
      Object.assign(values, { approvalStatus: needsApproval ? 'PENDING' : 'NOT_REQUIRED', approvalRemark: '', approvedBy: '', approvedAt: null });
    }
  }

  if (existing) {
    Object.assign(existing, values);
    return existing.save();
  }
  values.entryId = `LOSS-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
  return LossEntry.create(values);
};

const removeLoss = async (refId, stage) => {
  if (!refId) return;
  const q = { refId };
  if (stage) q.stage = stage;
  await LossEntry.deleteMany(q);
};

module.exports = {
  STAGES, STAGE_KEYS, REASONS, DEFAULT_LIMITS, limitFor,
  getSettings, saveSettings,
  buildSplit, resplit, splitSummary,
  recordLoss, removeLoss, kgFactor
};
