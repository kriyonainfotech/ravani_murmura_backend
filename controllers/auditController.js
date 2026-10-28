const AuditLog = require('../models/AuditLog');
const Stock = require('../models/Stock');
const Purchase = require('../models/Purchase');
const PackagingRequest = require('../models/PackagingRequest');
const MachineRun = require('../models/MachineRun');
const ReadyStock = require('../models/ReadyStock');
const PackagingDispatch = require('../models/PackagingDispatch');
const Sale = require('../models/Sale');
const LossEntry = require('../models/LossEntry');

const CORRECTION_PATH = /^(PUT|PATCH|DELETE) \/api\/(purchases|stocks|machine|tracking\/master|dispatch(\/ready-stock)?|sales(\/store-stock)?|packaging\/requests)\/[^/?]+$/;

const escapeRegex =(s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/audit?action=&collection=&search=&from=&to=&page=&limit=
exports.getLogs = async (req, res) => {
  try {
    const { action, collection, search, from, to } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const filter = {};
    if (action) filter.action = action;
    if (collection) filter.collectionName = collection;
    if (from || to) {
      filter.at = {};
      if (from) filter.at.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.at.$lte = d; }
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ docCode: rx }, { byName: rx }, { 'changes.field': rx }];
    }

    const [logs, total, collections] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct('collectionName')
    ]);
    res.json({ logs, total, page, pages: Math.ceil(total / limit) || 1, collections: collections.sort() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/audit/batch/:batchId — full story of one purchase batch, oldest first:
// who did what and when, from purchase to shop return / sale.
exports.getBatchTimeline = async (req, res) => {
  try {
    const { batchId } = req.params;
    const stock = await Stock.findOne({ batchId }).lean();
    if (!stock) return res.status(404).json({ message: 'Batch not found' });

    const events = [];
    const add = (at, stage, title, detail, by) => { if (at) events.push({ at, stage, title, detail: detail || '', by: by || '' }); };
    const kg = (n) => `${Math.round((Number(n) || 0) * 1000) / 1000} kg`;

    const purchase = await Purchase.findById(stock.purchaseId).lean();
    if (purchase) {
      add(purchase.createdAt, 'Created', `Purchase ${purchase.purchaseId}`,
        `${purchase.supplier} · ${kg(purchase.quantity)} @ ₹${purchase.rate}/kg`, purchase.createdBy);
      if (purchase.status === 'Completed') {
        const done = await AuditLog.findOne({ docId: purchase._id, 'changes.field': 'status' }).sort({ at: -1 }).lean();
        add(done?.at || purchase.updatedAt, 'Received', 'Purchase received at shop',
          `Received ${kg(purchase.receivedQuantity ?? purchase.quantity)}`, done?.byName);
      }
    }
    add(stock.createdAt, 'Created', `Batch ${batchId} added to stock`, `${stock.productName} · ${kg(stock.purchasedQuantity)}`, stock.createdBy);

    const requests = await PackagingRequest.find({ stockId: stock._id }).lean();
    requests.forEach(r => {
      add(r.dispatchedAt || r.createdAt, 'In Transit', `Sent to packaging (${r.requestId})`,
        `${kg(r.sentQuantity)} · ${r.packagingRollQuantity || 0} rolls · ${r.driverName || ''} ${r.tempoNumberPlate || ''}`.trim(), r.createdBy);
      if (r.receivedAt) {
        add(r.receivedAt, 'Received', 'Received at packaging',
          `${kg(r.receivedQuantity)} · ${r.receivedPackagingRollQuantity || 0} rolls${r.shortageReason ? ` · ${r.shortageReason}` : ''}`, r.receivedBy);
      }
    });

    const runs = await MachineRun.find({ stockId: stock._id }).lean();
    runs.forEach(r => {
      add(r.startTime, 'In Process', `Machine ${r.machineNumber} started (${r.runId})`, `${kg(r.plannedRawQuantity)} planned`, r.operatorName);
      (r.mountedRolls || []).forEach((m, i) => add(m.mountedAt, 'In Process', `Roll ${i + 1} put on machine ${r.machineNumber}`, m.rollType, r.operatorName));
      if (r.status === 'COMPLETED') {
        add(r.endTime, 'Ready', `Machine ${r.machineNumber} run finished`,
          `${r.totalReadyPackets} theli (${kg(r.readyWeightKg)}) · waste ${kg(r.wastageWeightKg)}`, r.operatorName);
      }
      if (r.status === 'CANCELLED') add(r.endTime || r.updatedAt, 'In Process', `Machine run ${r.runId} cancelled`, '', r.operatorName);
    });

    const ready = await ReadyStock.find({ stockBatchId: batchId }).lean();
    const readyIds = ready.map(r => r._id);
    const dispatches = await PackagingDispatch.find({ $or: [{ stockBatchId: batchId }, { readyStockId: { $in: readyIds } }] }).lean();
    dispatches.forEach(d => {
      add(d.dispatchedAt || d.createdAt, 'Dispatched', `Dispatched to ${d.destinationStore} (${d.dispatchId})`,
        `${d.packetsToDispatch} theli · ${d.driverName || ''} ${d.tempoNumberPlate || ''}`.trim(), d.preparedBy);
      if (d.isReceivedAtShop) {
        add(d.receivedAt, 'Completed', `Received at ${d.destinationStore}`, `${d.receivedPackets ?? d.packetsToDispatch} theli`, d.receivedBy);
      }
    });

    const sales = await Sale.find({ 'items.stockBatchId': batchId }).lean();
    sales.forEach(s => {
      const theli = s.items.filter(i => i.stockBatchId === batchId).reduce((a, i) => a + (i.quantityTheli || 0), 0);
      add(s.saleDate || s.createdAt, 'Sold', `Sale ${s.saleId}`, `${theli} theli to ${s.customerName} (from ${s.sellFrom})`, s.createdBy);
    });

    const losses = await LossEntry.find({ stockBatchId: batchId }).lean();
    losses.forEach(l => {
      const parts = [];
      if (l.wastageQty) parts.push(`waste ${l.wastageQty} ${l.unit.toLowerCase()} (${l.wastageReason || 'no reason'})`);
      if (l.differenceQty) parts.push(`difference ${l.differenceQty} ${l.unit.toLowerCase()} (${l.differenceReason || 'no reason'})`);
      if (parts.length) add(l.entryDate, 'Loss', `Loss recorded · ${l.stage.replace(/_/g, ' ').toLowerCase()}`, parts.join(' · '), l.recordedBy);
    });

    // Corrections and deletes made by the admin on this batch's records
    const codes = [batchId, purchase?.purchaseId, ...requests.map(r => r.requestId), ...runs.map(r => r.runId),
      ...ready.map(r => r.productionBatchId), ...dispatches.map(d => d.dispatchId)].filter(Boolean);
    // Only the admin edit / delete endpoints; normal workflow steps (receive, complete...) are already listed above
    const audits = await AuditLog.find({ docCode: { $in: codes }, action: { $ne: 'CREATE' }, path: CORRECTION_PATH }).lean();
    audits.forEach(a => {
      const fields = (a.changes || []).map(c => c.field).join(', ');
      add(a.at, 'Correction', `${a.action === 'DELETE' ? 'Deleted' : 'Edited'} ${a.collectionName} ${a.docCode}`, fields, a.byName);
    });

    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json({ batchId, productName: stock.productName, location: stock.location, events });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
