const Sale = require('../models/Sale');
const Stock = require('../models/Stock');
const Purchase = require('../models/Purchase');
const ReadyStock = require('../models/ReadyStock');
const ShopStock = require('../models/ShopStock');
const MachineRun = require('../models/MachineRun');
const PackagingDispatch = require('../models/PackagingDispatch');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// Dashboard numbers. With ?storeName=X only that store's sales and stock are counted
// (store panel); without it the whole business is shown (super admin).
exports.getDashboard = async (req, res) => {
  try {
    const storeName = (req.query.storeName || '').trim();
    const isStore = !!storeName && storeName !== 'All';
    const storeRe = isStore ? new RegExp('^' + escapeRegex(storeName) + '$', 'i') : null;
    // A store only counts the bill lines sold out of its own stock
    // (older bills have no store name on the line, so match them by the store stock they came from)
    const storeStockIds = isStore ? (await ShopStock.find({ storeName: storeRe }).distinct('_id')) : [];
    const storeStockSet = new Set(storeStockIds.map(String));
    const itemInScope = (it) => !isStore || storeRe.test(it.storeName || '') || storeStockSet.has(String(it.inventorySourceId));

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const start7 = new Date(startToday);
    start7.setDate(start7.getDate() - 6);
    const since = start7 < startMonth ? start7 : startMonth;

    const saleScope = isStore ? { $or: [{ 'items.storeName': storeRe }, { 'items.inventorySourceId': { $in: storeStockIds } }] } : {};
    const [periodSales, recentSales, unpaidSales] = await Promise.all([
      Sale.find({ ...saleScope, saleDate: { $gte: since } }).lean(),
      Sale.find(saleScope).sort({ saleDate: -1, createdAt: -1 }).limit(6).lean(),
      Sale.find({ ...saleScope, paymentStatus: { $ne: 'Paid' } }).lean()
    ]);

    // Amount / profit of a sale within scope (whole bill for admin, own lines for a store)
    const totalsOf = (sale) => {
      if (!isStore) return { amount: sale.finalAmount || 0, profit: sale.totalProfit || 0, theli: sale.totalTheli || 0 };
      const lines = (sale.items || []).filter(itemInScope);
      const amount = lines.reduce((a, it) => a + (it.itemAmount || 0), 0);
      const cost = lines.reduce((a, it) => a + (it.itemCost || 0), 0);
      // Share the bill discount over the store's lines
      const share = sale.subTotal > 0 ? amount / sale.subTotal : 0;
      const net = amount - (sale.discount || 0) * share;
      return { amount: net, profit: net - cost, theli: lines.reduce((a, it) => a + (it.quantityTheli || 0), 0) };
    };

    const sum = (list) => list.reduce((a, s) => {
      const t = totalsOf(s);
      return { amount: a.amount + t.amount, profit: a.profit + t.profit, theli: a.theli + t.theli, bills: a.bills + 1 };
    }, { amount: 0, profit: 0, theli: 0, bills: 0 });

    const todaySales = periodSales.filter(s => new Date(s.saleDate) >= startToday);
    const monthSales = periodSales.filter(s => new Date(s.saleDate) >= startMonth);
    const today = sum(todaySales);
    const month = sum(monthSales);
    const unpaid = sum(unpaidSales);

    // Last 7 days, one entry per day (days without sales stay at 0)
    const trend = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start7);
      d.setDate(d.getDate() + i);
      trend.push({ date: dayKey(d), amount: 0, bills: 0 });
    }
    periodSales.forEach(s => {
      const day = trend.find(t => t.date === dayKey(s.saleDate));
      if (day) {
        day.amount += totalsOf(s).amount;
        day.bills += 1;
      }
    });

    // Best sellers this month
    const productMap = new Map();
    monthSales.forEach(s => (s.items || []).filter(itemInScope).forEach(it => {
      const key = `${it.productName}|${it.packetSizeGrams}`;
      const p = productMap.get(key) || { productName: it.productName, packetSizeGrams: it.packetSizeGrams, theli: 0, amount: 0, profit: 0 };
      p.theli += it.quantityTheli || 0;
      p.amount += it.itemAmount || 0;
      p.profit += it.itemProfit || 0;
      productMap.set(key, p);
    }));
    const topProducts = [...productMap.values()].sort((a, b) => b.amount - a.amount).slice(0, 5)
      .map(p => ({ ...p, amount: round2(p.amount), profit: round2(p.profit) }));

    // Ready theli at the store(s)
    const shopStocks = await ShopStock.find({ ...(isStore ? { storeName: storeRe } : {}), availablePackets: { $gt: 0 } }).lean();
    const shopByProduct = new Map();
    shopStocks.forEach(s => {
      const key = `${s.productType}|${s.packetSizeGrams}`;
      const p = shopByProduct.get(key) || { productName: s.productType, packetSizeGrams: s.packetSizeGrams, packets: 0, weightKg: 0 };
      p.packets += s.availablePackets || 0;
      p.weightKg += s.availableWeightKg || 0;
      shopByProduct.set(key, p);
    });
    const storeStock = {
      packets: shopStocks.reduce((a, s) => a + (s.availablePackets || 0), 0),
      weightKg: round2(shopStocks.reduce((a, s) => a + (s.availableWeightKg || 0), 0)),
      value: round2(shopStocks.reduce((a, s) => a + (s.availablePackets || 0) * (s.costPerPacket || 0), 0)),
      products: [...shopByProduct.values()].sort((a, b) => a.packets - b.packets)
    };

    // Dispatches on the way that the store has not confirmed yet
    const incoming = await PackagingDispatch.find({
      ...(isStore ? { destinationStore: storeRe } : {}),
      isReceivedAtShop: { $ne: true }
    }).sort({ dispatchedAt: -1 }).lean();

    const result = {
      scope: isStore ? 'store' : 'all',
      storeName: isStore ? storeName : '',
      today: { amount: round2(today.amount), profit: round2(today.profit), theli: today.theli, bills: today.bills },
      month: { amount: round2(month.amount), profit: round2(month.profit), theli: month.theli, bills: month.bills },
      unpaid: { amount: round2(unpaid.amount), bills: unpaid.bills },
      trend: trend.map(t => ({ ...t, amount: round2(t.amount) })),
      topProducts,
      recentSales: recentSales.map(s => ({
        _id: s._id, saleId: s.saleId, saleDate: s.saleDate, customerName: s.customerName,
        paymentStatus: s.paymentStatus, paymentMode: s.paymentMode, ...(() => {
          const t = totalsOf(s);
          return { amount: round2(t.amount), profit: round2(t.profit), theli: t.theli };
        })()
      })),
      storeStock,
      incoming: {
        count: incoming.length,
        packets: incoming.reduce((a, d) => a + (d.packetsToDispatch || 0), 0),
        list: incoming.slice(0, 5).map(d => ({
          _id: d._id, dispatchId: d.dispatchId, productType: d.productType, packetSizeGrams: d.packetSizeGrams,
          packets: d.packetsToDispatch, destinationStore: d.destinationStore, dispatchedAt: d.dispatchedAt
        }))
      }
    };

    // Whole-business numbers for the super admin
    if (!isStore) {
      const [stocks, readyStocks, pendingPurchases, activeRuns] = await Promise.all([
        Stock.find().lean(),
        ReadyStock.find({ availablePackets: { $gt: 0 } }).lean(),
        Purchase.find({ status: 'Pending' }).lean(),
        MachineRun.countDocuments({ status: { $in: ['RUNNING', 'PAUSED'] } })
      ]);
      result.rawStock = {
        kg: round2(stocks.reduce((a, s) => a + (s.remainingQuantity || 0), 0)),
        value: round2(stocks.reduce((a, s) => a + (s.remainingQuantity || 0) * (s.purchaseRate || 0), 0)),
        withPackagingKg: round2(stocks.reduce((a, s) => a + (s.inTransitQuantity || 0) + (s.packagingGodownQuantity || 0), 0)),
        lowBatches: stocks
          .filter(s => s.remainingQuantity > 0 && s.purchasedQuantity > 0 && s.remainingQuantity / s.purchasedQuantity <= 0.2)
          .map(s => ({ batchId: s.batchId, productName: s.productName, remainingQuantity: s.remainingQuantity, purchasedQuantity: s.purchasedQuantity }))
          .slice(0, 5)
      };
      result.readyStock = {
        packets: readyStocks.reduce((a, s) => a + (s.availablePackets || 0), 0),
        weightKg: round2(readyStocks.reduce((a, s) => a + (s.availableWeightKg || 0), 0)),
        value: round2(readyStocks.reduce((a, s) => a + (s.availablePackets || 0) * (s.costPerPacket || 0), 0))
      };
      result.pendingPurchases = {
        count: pendingPurchases.length,
        amount: round2(pendingPurchases.reduce((a, p) => a + (p.totalPrice || 0), 0))
      };
      result.activeRuns = activeRuns;

      // Sales this month per store (godown sales grouped separately)
      const shopNames = new Map((await ShopStock.find().select('storeName').lean()).map(x => [String(x._id), x.storeName]));
      const storeMap = new Map();
      monthSales.forEach(s => (s.items || []).forEach(it => {
        const name = s.sellFrom === 'Packaging Godown' ? 'Packaging Godown' : (it.storeName || shopNames.get(String(it.inventorySourceId)) || 'Shop');
        const st = storeMap.get(name) || { name, amount: 0, theli: 0 };
        st.amount += it.itemAmount || 0;
        st.theli += it.quantityTheli || 0;
        storeMap.set(name, st);
      }));
      result.storeSales = [...storeMap.values()].sort((a, b) => b.amount - a.amount).map(s => ({ ...s, amount: round2(s.amount) }));
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error loading dashboard', error: error.message });
  }
};

// Packaging panel dashboard: requests for this panel (?panelId=), godown, machines, production and dispatch
exports.getPackagingDashboard = async (req, res) => {
  try {
    const PackagingRequest = require('../models/PackagingRequest');
    const Machine = require('../models/Machine');
    const { panelId } = req.query;

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const start7 = new Date(startToday);
    start7.setDate(start7.getDate() - 6);
    const since = start7 < startMonth ? start7 : startMonth;

    const [requests, godown, machines, activeRuns, doneRuns, readyStocks, dispatches] = await Promise.all([
      PackagingRequest.find({ ...(panelId ? { targetPanelId: panelId } : {}), status: 'IN_TRANSIT' }).sort({ dispatchedAt: -1 }).lean(),
      Stock.find({ packagingGodownQuantity: { $gt: 0 } }).lean(),
      Machine.find().sort({ code: 1 }).lean(),
      MachineRun.find({ status: { $in: ['RUNNING', 'PAUSED'] } }).lean(),
      MachineRun.find({ status: 'COMPLETED', endTime: { $gte: since } }).lean(),
      ReadyStock.find({ availablePackets: { $gt: 0 } }).lean(),
      PackagingDispatch.find({ dispatchedAt: { $gte: since } }).sort({ dispatchedAt: -1 }).lean()
    ]);

    // Production per day for the last 7 days (theli packed)
    const trend = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start7);
      d.setDate(d.getDate() + i);
      trend.push({ date: dayKey(d), amount: 0, bills: 0 });
    }
    doneRuns.forEach(r => {
      const day = trend.find(t => t.date === dayKey(r.endTime));
      if (day) {
        day.amount += r.totalReadyPackets || 0;
        day.bills += 1;
      }
    });

    const sumRuns = (list) => list.reduce((a, r) => ({
      theli: a.theli + (r.totalReadyPackets || 0),
      readyKg: a.readyKg + (r.readyWeightKg || 0),
      rawKg: a.rawKg + (r.actualRawConsumed || 0),
      wastageKg: a.wastageKg + (r.wastageWeightKg || 0),
      runs: a.runs + 1
    }), { theli: 0, readyKg: 0, rawKg: 0, wastageKg: 0, runs: 0 });
    const today = sumRuns(doneRuns.filter(r => new Date(r.endTime) >= startToday));
    const month = sumRuns(doneRuns.filter(r => new Date(r.endTime) >= startMonth));

    const dispatchedToday = dispatches.filter(d => new Date(d.dispatchedAt) >= startToday);

    // Live machine board: each machine with its current run (if any)
    const machineBoard = machines.map(m => {
      const run = activeRuns.find(r => String(r.machineNumber) === String(m.code));
      return {
        code: m.code, name: m.name, isActive: m.isActive,
        run: run ? {
          runId: run.runId, status: run.status, stockBatchId: run.stockBatchId, productName: run.productName,
          plannedRawQuantity: run.plannedRawQuantity, rolls: (run.mountedRolls || []).length,
          operatorName: run.operatorName, startTime: run.startTime
        } : null
      };
    });

    // Ready theli by product
    const readyMap = new Map();
    readyStocks.forEach(s => {
      const key = `${s.productType}|${s.packetSizeGrams}`;
      const p = readyMap.get(key) || { productName: s.productType, packetSizeGrams: s.packetSizeGrams, packets: 0, weightKg: 0 };
      p.packets += s.availablePackets || 0;
      p.weightKg += s.availableWeightKg || 0;
      readyMap.set(key, p);
    });

    // Godown batches with raw material but no spare roll to pack it
    const noRolls = godown
      .filter(s => (s.packagingGodownQuantity - (s.packagingGodownReservedQuantity || 0)) > 0 && (s.packagingRollQuantity || 0) <= 0)
      .map(s => ({ batchId: s.batchId, productName: s.productName, rawKg: round2(s.packagingGodownQuantity - (s.packagingGodownReservedQuantity || 0)) }));

    res.json({
      incoming: {
        count: requests.length,
        kg: round2(requests.reduce((a, r) => a + (r.sentQuantity || 0), 0)),
        rolls: requests.reduce((a, r) => a + (r.packagingRollQuantity || 0), 0),
        list: requests.slice(0, 5).map(r => ({
          _id: r._id, requestId: r.requestId, stockBatchId: r.stockBatchId, productName: r.productName,
          sentQuantity: r.sentQuantity, packagingRollQuantity: r.packagingRollQuantity, dispatchedAt: r.dispatchedAt
        }))
      },
      godown: {
        rawKg: round2(godown.reduce((a, s) => a + s.packagingGodownQuantity - (s.packagingGodownReservedQuantity || 0), 0)),
        inMachineKg: round2(godown.reduce((a, s) => a + (s.packagingGodownReservedQuantity || 0), 0)),
        rolls: godown.reduce((a, s) => a + (s.packagingRollQuantity || 0), 0),
        batches: godown.length,
        noRolls
      },
      machines: {
        total: machines.filter(m => m.isActive).length,
        running: activeRuns.filter(r => r.status === 'RUNNING').length,
        paused: activeRuns.filter(r => r.status === 'PAUSED').length,
        board: machineBoard
      },
      today: { ...today, readyKg: round2(today.readyKg), rawKg: round2(today.rawKg), wastageKg: round2(today.wastageKg) },
      month: {
        ...month, readyKg: round2(month.readyKg), rawKg: round2(month.rawKg), wastageKg: round2(month.wastageKg),
        wastagePct: month.rawKg > 0 ? round2((month.wastageKg / month.rawKg) * 100) : 0
      },
      ready: {
        packets: readyStocks.reduce((a, s) => a + (s.availablePackets || 0), 0),
        weightKg: round2(readyStocks.reduce((a, s) => a + (s.availableWeightKg || 0), 0)),
        products: [...readyMap.values()].sort((a, b) => b.packets - a.packets).map(p => ({ ...p, weightKg: round2(p.weightKg) }))
      },
      dispatch: {
        todayPackets: dispatchedToday.reduce((a, d) => a + (d.packetsToDispatch || 0), 0),
        todayCount: dispatchedToday.length,
        recent: dispatches.slice(0, 5).map(d => ({
          _id: d._id, dispatchId: d.dispatchId, productType: d.productType, packetSizeGrams: d.packetSizeGrams,
          packets: d.packetsToDispatch, destinationStore: d.destinationStore, dispatchedAt: d.dispatchedAt,
          received: !!d.isReceivedAtShop
        }))
      },
      trend
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading packaging dashboard', error: error.message });
  }
};
