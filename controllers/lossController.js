const LossEntry = require('../models/LossEntry');
const User = require('../models/User');
const Purchase = require('../models/Purchase');
const Stock = require('../models/Stock');
const PackagingRequest = require('../models/PackagingRequest');
const MachineRun = require('../models/MachineRun');
const PackagingDispatch = require('../models/PackagingDispatch');
const {
  STAGES, STAGE_KEYS, REASONS, getSettings, saveSettings, resplit, recordLoss, limitFor
} = require('../utils/lossLedger');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const pct = (part, whole) => (whole > 0 ? r2((part / whole) * 100) : 0);
const stageMeta = (key) => STAGES.find(s => s.key === key) || { key, no: 0, label: key };
// Only losses the admin approved count in the totals (pending, rejected and within-limit ones are left out)
const counted = (e) => e.approvalStatus === 'APPROVED';
// Lost quantity of an entry, 0 while it is not accepted
const lostOf = (e, key) => (counted(e) ? Number(e[key]) || 0 : 0);

// Shared filters: ?from=YYYY-MM-DD&to=YYYY-MM-DD&stage=&product=&batch=&status=
const buildFilter = (q) => {
  const filter = {};
  if (q.stage && STAGE_KEYS.includes(q.stage)) filter.stage = q.stage;
  if (q.product) filter.productName = q.product;
  if (q.batch) filter.stockBatchId = q.batch;
  if (q.status) filter.approvalStatus = q.status;
  if (q.from || q.to) {
    filter.entryDate = {};
    if (q.from) filter.entryDate.$gte = new Date(`${q.from}T00:00:00`);
    if (q.to) filter.entryDate.$lte = new Date(`${q.to}T23:59:59.999`);
  }
  return filter;
};

// ---- Config / settings -------------------------------------------------------
exports.getConfig = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ stages: STAGES, defaultReasons: REASONS, ...settings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const settings = await saveSettings(req.body || {});
    res.json({ stages: STAGES, defaultReasons: REASONS, ...settings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---- Entries & approvals -----------------------------------------------------
exports.getEntries = async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    if (req.query.overLimit === 'true') filter.overLimit = true;
    // Photos are heavy: lists only say whether one exists, the photo itself loads on demand
    const entries = await LossEntry.find(filter).sort({ entryDate: -1 }).limit(2000).select('-photo').lean();
    const withPhoto = new Set((await LossEntry.find({ _id: { $in: entries.map(e => e._id) }, photo: { $nin: ['', null] } }).select('_id').lean()).map(e => String(e._id)));
    res.json(entries.map(e => ({ ...e, hasPhoto: withPhoto.has(String(e._id)) })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPendingCount = async (req, res) => {
  try {
    const count = await LossEntry.countDocuments({ approvalStatus: 'PENDING' });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const decide = (status) => async (req, res) => {
  try {
    const remark = String((req.body && req.body.remark) || '').trim();
    if (status === 'REJECTED' && !remark) return res.status(400).json({ message: 'Please write why this entry is rejected' });

    const entry = await LossEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    if (entry.approvalStatus === 'NOT_REQUIRED') return res.status(400).json({ message: 'This entry is within limit and needs no approval' });

    const admin = req.user && req.user.userId ? await User.findById(req.user.userId).select('email').lean() : null;
    entry.approvalStatus = status;
    entry.approvalRemark = remark;
    entry.approvedBy = admin ? admin.email : 'Super Admin';
    entry.approvedAt = new Date();
    await entry.save();
    res.json(entry);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.getPhoto = async (req, res) => {
  try {
    const entry = await LossEntry.findById(req.params.id).select('photo photoBy').lean();
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    res.json({ photo: entry.photo || '', photoBy: entry.photoBy || '' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /loss/entries/:id/photo  { photo: 'data:image/jpeg;base64,...' }  ('' removes it)
exports.setPhoto = async (req, res) => {
  try {
    const photo = String(req.body?.photo || '');
    if (photo && !/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
      return res.status(400).json({ message: 'Please choose a photo (JPG / PNG)' });
    }
    if (photo.length > 4 * 1024 * 1024) return res.status(400).json({ message: 'Photo is too big' });
    const entry = await LossEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    if (!photo && req.user?.role !== 'super_admin') {
      return res.status(403).json({ message: 'Only Super Admin can remove a photo' });
    }
    entry.photo = photo;
    entry.photoBy = photo ? (req.user?.name || '') : '';
    await entry.save();
    res.json({ message: photo ? 'Photo saved' : 'Photo removed', photo: entry.photo });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.approveEntry = decide('APPROVED');
exports.rejectEntry = decide('REJECTED');

// ---- Reports -----------------------------------------------------------------
// Top reasons with their KG, biggest first
const topReasons = (list, qtyKey, reasonKey) => {
  const map = new Map();
  list.forEach(e => {
    const kg = Math.abs(Number(e[qtyKey]) || 0);
    if (!kg) return;
    const reason = e[reasonKey] || 'Not given';
    map.set(reason, (map.get(reason) || 0) + kg);
  });
  return [...map.entries()].map(([reason, kg]) => ({ reason, kg: r3(kg) })).sort((a, b) => b.kg - a.kg);
};

// Per product: how much was lost at each of the 5 stages (KG; rolls excluded)
const productStages = (entries, settings) => {
  const kgEntries = entries.filter(e => e.unit !== 'ROLL');
  const build = (list) => {
    const stages = STAGES.map(s => {
      const st = list.filter(e => e.stage === s.key);
      const sum = (k) => st.reduce((a, e) => a + (Number(e[k]) || 0), 0);
      const lost = (k) => st.reduce((a, e) => a + lostOf(e, k), 0);
      const expectedKg = sum('expectedKg');
      const wastageKg = lost('wastageKg');
      const differenceKg = lost('differenceKg');
      return {
        stage: s.key, stageNo: s.no, stageLabel: s.label, flow: s.flow,
        entries: st.length,
        expectedKg: r3(expectedKg), wastageKg: r3(wastageKg), differenceKg: r3(differenceKg),
        lossKg: r3(wastageKg + differenceKg),
        wastagePct: pct(wastageKg, expectedKg), differencePct: pct(Math.abs(differenceKg), expectedKg),
        limitWastageQty: settings.limits[s.key].wastageQty, limitDifferenceQty: settings.limits[s.key].differenceQty,
        wastageReasons: topReasons(st.filter(counted), 'wastageKg', 'wastageReason'),
        differenceReasons: topReasons(st.filter(counted), 'differenceKg', 'differenceReason'),
        pending: st.filter(e => e.approvalStatus === 'PENDING').length
      };
    });
    const purchasedKg = stages[0].expectedKg;
    const wastageKg = r3(stages.reduce((a, s) => a + s.wastageKg, 0));
    const differenceKg = r3(stages.reduce((a, s) => a + s.differenceKg, 0));
    return { stages, purchasedKg, wastageKg, differenceKg, lossKg: r3(wastageKg + differenceKg), lossPct: pct(wastageKg + differenceKg, purchasedKg) };
  };
  const products = [...new Set(kgEntries.map(e => e.productName || 'Unknown'))].sort();
  const rows = products.map(p => ({ productName: p, ...build(kgEntries.filter(e => (e.productName || 'Unknown') === p)) }));
  return { rows, totals: { all: { productName: 'All products', ...build(kgEntries) } } };
};

const REPORTS = {
  'product-stages': productStages,

  // 1. Wastage and difference per stage, in KG so stages compare (rolls listed separately)
  'stage-summary': (entries, settings) => {
    const rows = [];
    STAGES.forEach(s => {
      const units = [...new Set(entries.filter(e => e.stage === s.key).map(e => e.unit))];
      if (units.length === 0) units.push(s.key === 'DISPATCH' || s.key === 'STORE_RECEIVE' ? 'THELI' : 'KG');
      units.forEach(unit => {
        const list = entries.filter(e => e.stage === s.key && e.unit === unit);
        const sum = (k) => list.reduce((a, e) => a + (Number(e[k]) || 0), 0);
        const lost = (k) => list.reduce((a, e) => a + lostOf(e, k), 0);
        const expectedQty = sum('expectedQty');
        const wastageQty = lost('wastageQty');
        const differenceQty = lost('differenceQty');
        rows.push({
          stage: s.key, stageNo: s.no, stageLabel: s.label, flow: s.flow, unit,
          entries: list.length,
          expectedQty: r3(expectedQty), wastageQty: r3(wastageQty), differenceQty: r3(differenceQty),
          expectedKg: r3(sum('expectedKg')), wastageKg: r3(lost('wastageKg')), differenceKg: r3(lost('differenceKg')),
          wastagePct: pct(wastageQty, expectedQty),
          differencePct: pct(Math.abs(differenceQty), expectedQty),
          limitWastageQty: limitFor(settings.limits, s.key, unit).wastageQty,
          limitDifferenceQty: limitFor(settings.limits, s.key, unit).differenceQty,
          overLimit: list.filter(e => e.overLimit).length,
          pending: list.filter(e => e.approvalStatus === 'PENDING').length
        });
      });
    });
    const kgRows = rows.filter(r => r.unit !== 'ROLL');
    const totals = {
      entries: rows.reduce((a, r) => a + r.entries, 0),
      wastageKg: r3(kgRows.reduce((a, r) => a + r.wastageKg, 0)),
      differenceKg: r3(kgRows.reduce((a, r) => a + r.differenceKg, 0)),
      overLimit: rows.reduce((a, r) => a + r.overLimit, 0),
      pending: rows.reduce((a, r) => a + r.pending, 0)
    };
    return { rows, totals };
  },

  // 2. Every entry with wastage
  'wastage-register': (entries) => {
    const rows = entries.filter(e => e.wastageQty > 0);
    return { rows, totals: { entries: rows.length, wastageKg: r3(rows.reduce((a, e) => a + lostOf(e, 'wastageKg'), 0)) } };
  },

  // 3. Every entry with a quantity difference (short or extra)
  'difference-register': (entries) => {
    const rows = entries.filter(e => e.differenceQty !== 0);
    return {
      rows,
      totals: {
        entries: rows.length,
        shortKg: r3(rows.filter(e => e.differenceKg > 0).reduce((a, e) => a + lostOf(e, 'differenceKg'), 0)),
        extraKg: r3(rows.filter(e => e.differenceKg < 0).reduce((a, e) => a + Math.abs(lostOf(e, 'differenceKg')), 0))
      }
    };
  },

  // 4. Which reasons cause the most loss
  'reason-analysis': (entries) => {
    const map = new Map();
    const add = (type, reason, e, qty, kg) => {
      const key = `${type}|${reason}`;
      if (!map.has(key)) map.set(key, { type, reason, count: 0, kg: 0, rolls: 0, stages: new Set() });
      const row = map.get(key);
      row.count += 1;
      if (e.unit === 'ROLL') row.rolls += qty; else row.kg += kg;
      row.stages.add(stageMeta(e.stage).label);
    };
    entries.filter(counted).forEach(e => {
      if (e.wastageQty > 0) add('Wastage', e.wastageReason || 'Not given', e, e.wastageQty, e.wastageKg);
      if (e.differenceQty !== 0) add('Difference', e.differenceReason || 'Not given', e, Math.abs(e.differenceQty), Math.abs(e.differenceKg));
    });
    const rows = [...map.values()].map(r => ({ ...r, kg: r3(r.kg), rolls: r3(r.rolls), stages: [...r.stages].join(', ') }));
    ['Wastage', 'Difference'].forEach(type => {
      const total = rows.filter(r => r.type === type).reduce((a, r) => a + r.kg, 0);
      rows.filter(r => r.type === type).forEach(r => { r.sharePct = pct(r.kg, total); });
    });
    rows.sort((a, b) => (a.type === b.type ? b.kg - a.kg : a.type.localeCompare(b.type)));
    return { rows, totals: { reasons: rows.length } };
  },

  // 5. Product / batch trace: loss at every stage for each raw material batch
  'batch-trace': (entries) => {
    const map = new Map();
    entries.forEach(e => {
      const key = e.stockBatchId || `(no batch) ${e.productName}`;
      if (!map.has(key)) {
        map.set(key, {
          stockBatchId: e.stockBatchId || '-', productName: e.productName, purchasedKg: 0, stages: {}, wastageKg: 0, differenceKg: 0, rolls: 0,
          entries: 0, wastageCount: 0, differenceCount: 0, pending: 0, lastDate: null
        });
      }
      const row = map.get(key);
      if (!row.productName && e.productName) row.productName = e.productName;
      // How many times wastage / difference was recorded for this batch
      row.entries += 1;
      if (e.wastageQty > 0) row.wastageCount += 1;
      if (e.differenceQty !== 0) row.differenceCount += 1;
      if (e.approvalStatus === 'PENDING') row.pending += 1;
      if (!row.lastDate || new Date(e.entryDate) > new Date(row.lastDate)) row.lastDate = e.entryDate;
      if (e.unit === 'ROLL') {
        row.rolls += lostOf(e, 'wastageQty') + lostOf(e, 'differenceQty');
        return;
      }
      if (e.stage === 'PURCHASE_RECEIVE') row.purchasedKg += e.expectedKg;
      const st = row.stages[e.stage] || { wastageKg: 0, differenceKg: 0 };
      st.wastageKg += lostOf(e, 'wastageKg');
      st.differenceKg += lostOf(e, 'differenceKg');
      row.stages[e.stage] = st;
      row.wastageKg += lostOf(e, 'wastageKg');
      row.differenceKg += lostOf(e, 'differenceKg');
    });
    const rows = [...map.values()].map(r => {
      const stages = {};
      STAGE_KEYS.forEach(k => {
        const st = r.stages[k] || { wastageKg: 0, differenceKg: 0 };
        stages[k] = { wastageKg: r3(st.wastageKg), differenceKg: r3(st.differenceKg) };
      });
      const totalLossKg = r3(r.wastageKg + r.differenceKg);
      return {
        ...r, stages, purchasedKg: r3(r.purchasedKg), wastageKg: r3(r.wastageKg), differenceKg: r3(r.differenceKg),
        rolls: r3(r.rolls), totalLossKg, lossPct: pct(totalLossKg, r.purchasedKg)
      };
    }).sort((a, b) => (a.productName || '').localeCompare(b.productName || '') || String(b.stockBatchId).localeCompare(String(a.stockBatchId)));
    return { rows, totals: { batches: rows.length, totalLossKg: r3(rows.reduce((a, r) => a + r.totalLossKg, 0)) } };
  },

  // 7. Who recorded how much loss, with their main reasons
  'member-wise': (entries) => {
    const map = new Map();
    entries.forEach(e => {
      const key = e.recordedBy || 'Not recorded';
      if (!map.has(key)) map.set(key, { member: key, entries: 0, wastageKg: 0, differenceKg: 0, rolls: 0, overLimit: 0, pending: 0, list: [] });
      const row = map.get(key);
      row.entries += 1;
      if (e.overLimit) row.overLimit += 1;
      if (e.approvalStatus === 'PENDING') row.pending += 1;
      if (e.unit === 'ROLL') row.rolls += lostOf(e, 'wastageQty') + lostOf(e, 'differenceQty');
      else { row.wastageKg += lostOf(e, 'wastageKg'); row.differenceKg += lostOf(e, 'differenceKg'); }
      if (counted(e)) row.list.push(e);
    });
    const rows = [...map.values()].map(({ list, ...r }) => ({
      ...r, wastageKg: r3(r.wastageKg), differenceKg: r3(r.differenceKg), rolls: r3(r.rolls),
      lossKg: r3(r.wastageKg + r.differenceKg),
      topReasons: [...topReasons(list.filter(e => e.unit !== 'ROLL'), 'wastageKg', 'wastageReason'),
        ...topReasons(list.filter(e => e.unit !== 'ROLL'), 'differenceKg', 'differenceReason')]
        .sort((a, b) => b.kg - a.kg).slice(0, 3).map(t => t.reason).join(', ')
    })).sort((a, b) => b.lossKg - a.lossKg);
    return { rows, totals: { members: rows.length, lossKg: r3(rows.reduce((a, r) => a + r.lossKg, 0)) } };
  },

  // 8. Loss value in Rs, grouped by purchase rate (KG lost x batch purchase rate)
  'rate-loss': (entries, settings, ctx) => {
    const map = new Map();
    entries.filter(e => e.unit !== 'ROLL').forEach(e => {
      const rate = ctx.rates.get(e.stockBatchId) || 0;
      if (!map.has(rate)) map.set(rate, { rate, batches: new Set(), entries: 0, wastageKg: 0, differenceKg: 0 });
      const row = map.get(rate);
      if (e.stockBatchId) row.batches.add(e.stockBatchId);
      row.entries += 1;
      row.wastageKg += lostOf(e, 'wastageKg');
      row.differenceKg += lostOf(e, 'differenceKg');
    });
    const rows = [...map.values()].map(r => ({
      rate: r.rate, batches: [...r.batches].join(', '), batchCount: r.batches.size, entries: r.entries,
      wastageKg: r3(r.wastageKg), differenceKg: r3(r.differenceKg),
      wastageValue: r2(r.wastageKg * r.rate), differenceValue: r2(r.differenceKg * r.rate),
      totalValue: r2((r.wastageKg + r.differenceKg) * r.rate)
    })).sort((a, b) => b.rate - a.rate);
    return { rows, totals: { totalValue: r2(rows.reduce((a, r) => a + r.totalValue, 0)), wastageValue: r2(rows.reduce((a, r) => a + r.wastageValue, 0)) } };
  },

  // 9. Loss per day
  'date-wise': (entries) => {
    const map = new Map();
    entries.forEach(e => {
      const day = new Date(e.entryDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      if (!map.has(day)) map.set(day, { date: day, entries: 0, wastageKg: 0, differenceKg: 0, rolls: 0, pending: 0 });
      const row = map.get(day);
      row.entries += 1;
      if (e.approvalStatus === 'PENDING') row.pending += 1;
      if (e.unit === 'ROLL') row.rolls += lostOf(e, 'wastageQty') + lostOf(e, 'differenceQty');
      else { row.wastageKg += lostOf(e, 'wastageKg'); row.differenceKg += lostOf(e, 'differenceKg'); }
    });
    const rows = [...map.values()].map(r => ({ ...r, wastageKg: r3(r.wastageKg), differenceKg: r3(r.differenceKg), rolls: r3(r.rolls), lossKg: r3(r.wastageKg + r.differenceKg) }))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { rows, totals: { days: rows.length, lossKg: r3(rows.reduce((a, r) => a + r.lossKg, 0)) } };
  },

  // 10. Loss per machine run, with rolls used and waste per roll
  'run-wise': (entries, settings, ctx) => {
    const rows = entries.filter(e => e.stage === 'MACHINE_PRODUCTION' && e.unit !== 'ROLL').map(e => {
      const run = ctx.runs.get(String(e.refId)) || {};
      const rolls = Number(run.actualRollsConsumed) || (run.mountedRolls || []).length || 0;
      const wastageKg = lostOf(e, 'wastageKg');
      return {
        _id: e._id, runId: run.runId || e.refCode, machine: run.machineNumber || e.party, stockBatchId: e.stockBatchId,
        productName: e.productName, date: e.entryDate, operator: run.operatorName || e.recordedBy,
        rawKg: r3(e.expectedKg), readyTheli: run.totalReadyPackets || 0, rolls,
        wastageKg: r3(wastageKg), differenceKg: r3(lostOf(e, 'differenceKg')),
        wastagePct: pct(wastageKg, e.expectedKg), wastePerRollKg: rolls ? r3(wastageKg / rolls) : 0,
        reason: [e.wastageReason, e.differenceReason].filter(Boolean).join(' / '), approvalStatus: e.approvalStatus
      };
    });
    return { rows, totals: { runs: rows.length, wastageKg: r3(rows.reduce((a, r) => a + r.wastageKg, 0)), rolls: rows.reduce((a, r) => a + r.rolls, 0) } };
  },

  // 6. Entries that crossed the limit and what the admin decided
  approvals: (entries) => {
    const rows = entries.filter(e => e.approvalStatus !== 'NOT_REQUIRED' || e.overLimit);
    const count = (s) => rows.filter(e => e.approvalStatus === s).length;
    return { rows, totals: { entries: rows.length, pending: count('PENDING'), approved: count('APPROVED'), rejected: count('REJECTED') } };
  }
};

exports.getReport = async (req, res) => {
  try {
    const build = REPORTS[req.params.type];
    if (!build) return res.status(404).json({ message: 'Unknown report' });
    const filter = buildFilter(req.query);
    const [entries, settings] = await Promise.all([
      LossEntry.find(filter).sort({ entryDate: -1 }).select('-photo').lean(),
      getSettings()
    ]);
    // Extra lookups only the rate / run reports need
    const ctx = { rates: new Map(), runs: new Map() };
    if (req.params.type === 'rate-loss') {
      const stocks = await Stock.find({ batchId: { $in: [...new Set(entries.map(e => e.stockBatchId).filter(Boolean))] } }).select('batchId purchaseRate').lean();
      stocks.forEach(st => ctx.rates.set(st.batchId, st.purchaseRate || 0));
    }
    if (req.params.type === 'run-wise') {
      const ids = entries.filter(e => e.stage === 'MACHINE_PRODUCTION').map(e => e.refId);
      const runs = await MachineRun.find({ _id: { $in: ids } }).lean();
      runs.forEach(r => ctx.runs.set(String(r._id), r));
    }
    res.json({ type: req.params.type, ...build(entries, settings, ctx) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Products and batches that appear in the ledger (for report filters)
exports.getFilterOptions = async (req, res) => {
  try {
    const [products, batches] = await Promise.all([
      LossEntry.distinct('productName'),
      LossEntry.distinct('stockBatchId')
    ]);
    res.json({ products: products.filter(Boolean).sort(), batches: batches.filter(Boolean).sort() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---- Import entries recorded before the ledger existed -----------------------
// Old screens stored one reason for the whole gap, so the gap goes to "difference"
// (machine runs keep their wastage). Over-limit old entries are auto-approved.
exports.backfill = async (req, res) => {
  try {
    const counts = { purchases: 0, transfers: 0, machineRuns: 0, dispatches: 0, storeReceipts: 0 };
    const has = async (stage, refId) => !!(await LossEntry.exists({ stage, refId }));

    for (const p of await Purchase.find({ status: 'Completed' })) {
      if (await has('PURCHASE_RECEIVE', p._id)) continue;
      const received = p.receivedQuantity != null ? p.receivedQuantity : p.quantity;
      const split = p.receiveLoss || resplit({ differenceReason: p.wasteReason || '' }, p.quantity, received, 'received');
      if (!p.receiveLoss) { p.receiveLoss = split; await p.save(); }
      const stock = await Stock.findOne({ purchaseId: p._id }).select('batchId').lean();
      await recordLoss({
        stage: 'PURCHASE_RECEIVE', unit: 'KG', refModel: 'Purchase', refId: p._id, refCode: p.purchaseId,
        productName: p.item, stockBatchId: stock ? stock.batchId : '', party: p.supplier,
        split, recordedBy: p.createdBy, entryDate: p.purchaseDate, autoApprove: true
      });
      counts.purchases += 1;
    }

    for (const r of await PackagingRequest.find({ status: { $ne: 'IN_TRANSIT' } })) {
      if (await has('GODOWN_TRANSFER', r._id)) continue;
      const legacy = { differenceReason: r.shortageReason || '' };
      if (!r.rawLoss) r.rawLoss = resplit(legacy, r.sentQuantity || 0, r.receivedQuantity || 0, 'received');
      if (!r.rollLoss) r.rollLoss = resplit(legacy, r.packagingRollQuantity || 0, r.receivedPackagingRollQuantity || 0, 'received');
      await r.save();
      const common = {
        stage: 'GODOWN_TRANSFER', refModel: 'PackagingRequest', refId: r._id, refCode: r.requestId,
        productName: r.productName, stockBatchId: r.stockBatchId, party: r.toAddress || '',
        recordedBy: r.createdBy, entryDate: r.receivedAt || r.updatedAt, autoApprove: true
      };
      await recordLoss({ ...common, unit: 'KG', split: r.rawLoss });
      if (r.rollLoss.expectedQty > 0 || r.rollLoss.actualQty > 0) await recordLoss({ ...common, unit: 'ROLL', split: r.rollLoss });
      counts.transfers += 1;
    }

    for (const run of await MachineRun.find({ status: 'COMPLETED' })) {
      if (await has('MACHINE_PRODUCTION', run._id)) continue;
      if (!run.productionLoss) {
        run.productionLoss = resplit({ wastageQty: run.wastageWeightKg, wastageReason: run.wastageReason || '' },
          run.actualRawConsumed || 0, run.readyWeightKg || 0);
        run.wastageWeightKg = run.productionLoss.wastageQty;
        run.differenceWeightKg = run.productionLoss.differenceQty;
        await run.save();
      }
      await recordLoss({
        stage: 'MACHINE_PRODUCTION', unit: 'KG', refModel: 'MachineRun', refId: run._id, refCode: run.runId,
        productName: run.productName, stockBatchId: run.stockBatchId, party: `Machine ${run.machineNumber}`,
        split: run.productionLoss, recordedBy: run.operatorName, entryDate: run.endTime || run.updatedAt, autoApprove: true
      });
      counts.machineRuns += 1;
    }

    for (const d of await PackagingDispatch.find()) {
      const common = {
        unit: 'THELI', refModel: 'PackagingDispatch', refId: d._id, refCode: d.dispatchId,
        productName: d.productType, stockBatchId: d.stockBatchId, packetSizeGrams: d.packetSizeGrams,
        party: d.destinationStore, autoApprove: true
      };
      const sent = Number(d.packetsToDispatch) || 0;
      if (!(await has('DISPATCH', d._id))) {
        if (!d.dispatchLoss) d.dispatchLoss = resplit({}, sent, sent);
        await recordLoss({ ...common, stage: 'DISPATCH', split: d.dispatchLoss, recordedBy: d.preparedBy, entryDate: d.dispatchedAt });
        counts.dispatches += 1;
      }
      if (d.isReceivedAtShop && !(await has('STORE_RECEIVE', d._id))) {
        if (!d.receiveLoss) {
          d.receivedPackets = sent;
          d.receiveLoss = resplit({}, sent, sent);
        }
        await recordLoss({ ...common, stage: 'STORE_RECEIVE', split: d.receiveLoss, recordedBy: d.destinationStore, entryDate: d.receivedAt || d.updatedAt });
        counts.storeReceipts += 1;
      }
      if (d.isModified()) await d.save();
    }

    res.json({ message: 'Old entries imported', counts });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
