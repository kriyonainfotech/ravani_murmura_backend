const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Purchase = require('../models/Purchase');
const Payment = require('../models/Payment');
const Expense = require('../models/Expense');
const Account = require('../models/Account');
const {
  round2, salePaid, purchasePaid, statusFor, PAYMENT_MODES, ACCOUNTS, DEFAULT_EXPENSE_CATEGORIES,
  nextPaymentId, nextExpenseId, purchasePaymentError, payPurchase, fundsError
} = require('../utils/finance');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPurchaseCategory = (c) => String(c || '').trim().toLowerCase() === 'purchase';

// ?from=YYYY-MM-DD&to=YYYY-MM-DD -> mongo date filter (either side optional)
const dateRange = ({ from, to }) => {
  const range = {};
  if (from) range.$gte = new Date(new Date(from).setHours(0, 0, 0, 0));
  if (to) range.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
  return Object.keys(range).length ? range : null;
};

const saleRow = (s) => {
  const total = Number(s.finalAmount) || 0;
  const paid = Math.min(salePaid(s), total);
  return {
    _id: s._id,
    billNo: s.saleId,
    date: s.saleDate,
    partyName: s.customerName || 'Walk-in Customer',
    partyMobile: s.customerMobile || '',
    sellFrom: s.sellFrom,
    totalTheli: s.totalTheli,
    totalWeightKg: s.totalWeightKg,
    total: round2(total),
    profit: round2(s.totalProfit),
    paid: round2(paid),
    due: round2(Math.max(total - paid, 0)),
    status: statusFor(paid, total),
    paymentMode: s.paymentMode
  };
};

const purchaseRow = (p) => {
  const total = Number(p.totalPrice) || 0;
  const paid = Math.min(purchasePaid(p), total);
  return {
    _id: p._id,
    billNo: p.purchaseId,
    billNumber: p.billNumber || '',
    date: p.purchaseDate,
    partyName: p.supplier,
    partyMobile: p.partyMobileNumber || '',
    item: p.item,
    quantity: p.quantity,
    rate: p.rate,
    total: round2(total),
    paid: round2(paid),
    due: round2(Math.max(total - paid, 0)),
    status: statusFor(paid, total)
  };
};

const totalsOf = (rows) => ({
  count: rows.length,
  total: round2(rows.reduce((a, r) => a + r.total, 0)),
  paid: round2(rows.reduce((a, r) => a + r.paid, 0)),
  due: round2(rows.reduce((a, r) => a + r.due, 0)),
  profit: round2(rows.reduce((a, r) => a + (r.profit || 0), 0))
});

const filterRows = (rows, { status, search }) => {
  let out = rows;
  if (status && status !== 'All') {
    out = status === 'Due' ? out.filter(r => r.due > 0) : out.filter(r => r.status === status);
  }
  if (search) {
    const q = String(search).toLowerCase();
    out = out.filter(r => [r.billNo, r.billNumber, r.partyName, r.partyMobile, r.item].some(v => v && String(v).toLowerCase().includes(q)));
  }
  return out;
};

// ---------- Sale Book ----------

// Every sale bill with what was received and what is still due
exports.getSaleBook = async (req, res) => {
  try {
    const range = dateRange(req.query);
    const sales = await Sale.find(range ? { saleDate: range } : {}).sort({ saleDate: -1, createdAt: -1 });
    const rows = filterRows(sales.map(saleRow), req.query);
    res.json({ bills: rows, totals: totalsOf(rows) });
  } catch (error) {
    res.status(500).json({ message: 'Error loading sale book', error: error.message });
  }
};

// Purchase bills with paid / due (used to pick a bill for a Purchase expense)
exports.getPurchaseBook = async (req, res) => {
  try {
    const range = dateRange(req.query);
    const purchases = await Purchase.find(range ? { purchaseDate: range } : {}).sort({ purchaseDate: -1, createdAt: -1 });
    const rows = filterRows(purchases.map(purchaseRow), req.query);
    res.json({ bills: rows, totals: totalsOf(rows) });
  } catch (error) {
    res.status(500).json({ message: 'Error loading purchase bills', error: error.message });
  }
};

// ---------- Party Dues ----------

// Unpaid amount per party, all time: ?type=customer (sale bills) or ?type=supplier (purchase bills)
exports.getPartyDues = async (req, res) => {
  try {
    const supplier = req.query.type === 'supplier';
    const docs = supplier ? await Purchase.find() : await Sale.find();
    const rows = docs.map(supplier ? purchaseRow : saleRow);

    const parties = new Map();
    rows.forEach(r => {
      const name = String(r.partyName || '').trim() || (supplier ? 'Unknown Supplier' : 'Walk-in Customer');
      const key = name.toLowerCase();
      if (!parties.has(key)) {
        parties.set(key, { name, mobile: '', bills: 0, dueBills: 0, total: 0, paid: 0, due: 0, oldestDue: null, lastBill: null });
      }
      const p = parties.get(key);
      if (!p.mobile && r.partyMobile) p.mobile = r.partyMobile;
      p.bills += 1;
      p.total = round2(p.total + r.total);
      p.paid = round2(p.paid + r.paid);
      p.due = round2(p.due + r.due);
      if (r.due > 0) {
        p.dueBills += 1;
        if (!p.oldestDue || new Date(r.date) < new Date(p.oldestDue)) p.oldestDue = r.date;
      }
      if (!p.lastBill || new Date(r.date) > new Date(p.lastBill)) p.lastBill = r.date;
    });

    let list = [...parties.values()];
    if (req.query.onlyDue === 'true') list = list.filter(p => p.due > 0);
    if (req.query.search) {
      const q = String(req.query.search).toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.mobile.includes(q));
    }
    list.sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));

    res.json({
      parties: list,
      totals: {
        parties: list.length,
        withDue: list.filter(p => p.due > 0).length,
        total: round2(list.reduce((a, p) => a + p.total, 0)),
        paid: round2(list.reduce((a, p) => a + p.paid, 0)),
        due: round2(list.reduce((a, p) => a + p.due, 0))
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading party dues', error: error.message });
  }
};

// ---------- Collection ----------

// Collections log; ?bill=<sale _id> for one bill's history
exports.getPayments = async (req, res) => {
  try {
    const { bill, search, mode, account } = req.query;
    const query = {};
    if (bill && mongoose.Types.ObjectId.isValid(bill)) query.sale = bill;
    if (mode && mode !== 'All') query.mode = mode;
    if (account && account !== 'All') query.account = account;
    const range = dateRange(req.query);
    if (range) query.paymentDate = range;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ paymentId: rx }, { billNo: rx }, { partyName: rx }, { reference: rx }];
    }

    const payments = await Payment.find(query).sort({ paymentDate: -1, createdAt: -1 });
    const byMode = {};
    const byAccount = {};
    payments.forEach(p => {
      byMode[p.mode] = round2((byMode[p.mode] || 0) + p.amount);
      byAccount[p.account] = round2((byAccount[p.account] || 0) + p.amount);
    });
    res.json({
      payments,
      totals: { count: payments.length, amount: round2(payments.reduce((a, p) => a + p.amount, 0)), byMode, byAccount }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading collections', error: error.message });
  }
};

// Record money received from a customer against a sale bill
exports.createPayment = async (req, res) => {
  try {
    const { billId, amount, mode = 'Cash', account = 'Cash', paymentDate, reference = '', notes = '', createdBy = 'Admin' } = req.body;
    if (!mongoose.Types.ObjectId.isValid(billId)) return res.status(400).json({ message: 'Select a sale bill' });
    if (!PAYMENT_MODES.includes(mode)) return res.status(400).json({ message: 'Invalid payment mode' });
    if (!ACCOUNTS.includes(account)) return res.status(400).json({ message: 'Received In must be Cash, Company Bank or Personal Bank' });
    const amt = round2(amount);
    if (!(amt > 0)) return res.status(400).json({ message: 'Amount must be more than 0' });

    const sale = await Sale.findById(billId);
    if (!sale) return res.status(404).json({ message: 'Sale bill not found' });

    const row = saleRow(sale);
    if (row.due <= 0) return res.status(400).json({ message: `Bill ${row.billNo} is already fully paid` });
    if (amt > row.due + 0.005) return res.status(400).json({ message: `Amount is more than the due ₹${row.due} on ${row.billNo}` });

    const payment = await Payment.create({
      paymentId: await nextPaymentId(),
      sale: sale._id,
      billNo: row.billNo,
      partyName: row.partyName,
      amount: amt,
      mode,
      account,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      reference,
      notes,
      createdBy
    });

    // Keep the bill's own paid amount / status in sync so Sales & Billing shows it too
    const newPaid = round2(row.paid + amt);
    sale.amountPaid = newPaid;
    sale.paymentStatus = statusFor(newPaid, row.total);
    await sale.save();

    res.status(201).json(payment);
  } catch (error) {
    res.status(500).json({ message: 'Error saving collection', error: error.message });
  }
};

// Remove a collection and give the amount back to the bill's due
exports.deletePayment = async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Collection not found' });

    const sale = await Sale.findById(payment.sale);
    if (sale) {
      const row = saleRow(sale);
      const newPaid = round2(Math.max(row.paid - payment.amount, 0));
      sale.amountPaid = newPaid;
      sale.paymentStatus = statusFor(newPaid, row.total);
      await sale.save();
    }
    await Payment.findByIdAndDelete(payment._id);
    res.json({ message: 'Collection deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting collection', error: error.message });
  }
};

// ---------- Accounts ----------

// Balance of each account: opening + collections received in it - expenses paid from it (all time)
exports.getAccounts = async (req, res) => {
  try {
    const [openings, ins, outs] = await Promise.all([
      Account.find(),
      Payment.aggregate([{ $group: { _id: '$account', total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $group: { _id: '$paidFrom', total: { $sum: '$amount' } } }])
    ]);
    const sumFor = (rows, name) => rows.find(r => r._id === name)?.total || 0;
    const accounts = ACCOUNTS.map(name => {
      const saved = openings.find(a => a.name === name);
      const opening = saved?.openingBalance || 0;
      const received = sumFor(ins, name);
      const spent = sumFor(outs, name);
      return {
        name, opening: round2(opening), openingDate: saved?.openingDate || null,
        received: round2(received), spent: round2(spent), balance: round2(opening + received - spent)
      };
    });
    res.json({
      accounts,
      total: round2(accounts.reduce((a, x) => a + x.balance, 0)),
      // false until opening balances have been saved once (the page shows a reminder)
      openingSet: openings.length > 0
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading account balances', error: error.message });
  }
};

// Every entry of one account, oldest first, with the balance after each — shows why a balance went down / negative
exports.getAccountLedger = async (req, res) => {
  try {
    const name = req.params.name;
    if (!ACCOUNTS.includes(name)) return res.status(400).json({ message: 'Unknown account' });
    const [saved, ins, outs] = await Promise.all([
      Account.findOne({ name }),
      Payment.find({ account: name }),
      Expense.find({ paidFrom: name })
    ]);
    const entries = [
      ...ins.map(p => ({
        _id: p._id, kind: 'IN', date: p.paymentDate || p.createdAt, createdAt: p.createdAt, amount: round2(p.amount),
        ref: p.paymentId, title: `Collection · ${p.partyName || ''}`.trim(), sub: [p.billNo, p.mode, p.reference].filter(Boolean).join(' · ')
      })),
      ...outs.map(e => ({
        _id: e._id, kind: 'OUT', date: e.expenseDate || e.createdAt, createdAt: e.createdAt, amount: round2(e.amount),
        ref: e.expenseId, title: `${e.category}${e.paidTo ? ` · ${e.paidTo}` : ''}`, sub: [e.billNo, e.description, e.reference].filter(Boolean).join(' · ')
      }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt));

    const opening = round2(saved?.openingBalance || 0);
    let balance = opening;
    const rows = entries.map(e => {
      balance = round2(balance + (e.kind === 'IN' ? e.amount : -e.amount));
      return { ...e, balance };
    });
    res.json({ name, opening, openingDate: saved?.openingDate || null, balance, entries: rows.reverse() });
  } catch (error) {
    res.status(500).json({ message: 'Error loading account history', error: error.message });
  }
};

// Money each account had before entries started here: { balances: { Cash: 5000, ... }, date: 'YYYY-MM-DD' }
exports.setOpeningBalances = async (req, res) => {
  try {
    const { balances = {}, date } = req.body;
    const updates = [];
    for (const name of ACCOUNTS) {
      if (balances[name] === undefined) continue;
      const value = Number(balances[name] === '' ? 0 : balances[name]);
      if (!Number.isFinite(value) || value < 0) return res.status(400).json({ message: `Enter a valid opening balance for ${name}` });
      updates.push({ name, value: round2(value) });
    }
    if (!updates.length) return res.status(400).json({ message: 'Enter at least one opening balance' });
    const openingDate = date ? new Date(date) : new Date();
    if (Number.isNaN(openingDate.getTime())) return res.status(400).json({ message: 'Invalid date' });

    await Promise.all(updates.map(u => Account.findOneAndUpdate(
      { name: u.name },
      { openingBalance: u.value, openingDate },
      { upsert: true }
    )));
    res.json({ message: 'Opening balances saved' });
  } catch (error) {
    res.status(500).json({ message: 'Error saving opening balances', error: error.message });
  }
};

// ---------- Expense ----------

// Default categories plus any custom ones already used
exports.getExpenseCategories = async (req, res) => {
  try {
    const used = await Expense.distinct('category');
    const all = [...DEFAULT_EXPENSE_CATEGORIES];
    used.forEach(c => { if (c && !all.some(a => a.toLowerCase() === c.toLowerCase())) all.push(c); });
    res.json({ categories: all, accounts: ACCOUNTS });
  } catch (error) {
    res.status(500).json({ message: 'Error loading expense categories', error: error.message });
  }
};

// Expense list with totals by paid-from and by category; ?category ?paidFrom ?search ?from ?to
exports.getExpenses = async (req, res) => {
  try {
    const { category, paidFrom, search } = req.query;
    const query = {};
    if (category && category !== 'All') query.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
    if (paidFrom && paidFrom !== 'All') query.paidFrom = paidFrom;
    const range = dateRange(req.query);
    if (range) query.expenseDate = range;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ expenseId: rx }, { billNo: rx }, { paidTo: rx }, { description: rx }, { reference: rx }, { category: rx }];
    }

    const expenses = await Expense.find(query).sort({ expenseDate: -1, createdAt: -1 });
    const bySource = {};
    const byCategory = {};
    expenses.forEach(e => {
      bySource[e.paidFrom] = round2((bySource[e.paidFrom] || 0) + e.amount);
      byCategory[e.category] = round2((byCategory[e.category] || 0) + e.amount);
    });
    res.json({
      expenses,
      totals: { count: expenses.length, amount: round2(expenses.reduce((a, e) => a + e.amount, 0)), bySource, byCategory }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error loading expenses', error: error.message });
  }
};

// Add an expense. Category 'Purchase' must name a purchase bill; the amount is counted as paid on that bill.
exports.createExpense = async (req, res) => {
  try {
    const { amount, paidFrom = 'Cash', category, purchaseId, expenseDate, paidTo = '', description = '', reference = '', createdBy = 'Admin' } = req.body;
    const amt = round2(amount);
    if (!(amt > 0)) return res.status(400).json({ message: 'Amount must be more than 0' });
    if (!ACCOUNTS.includes(paidFrom)) return res.status(400).json({ message: 'Paid From must be Cash, Company Bank or Personal Bank' });
    const cat = String(category || '').trim();
    if (!cat) return res.status(400).json({ message: 'Select a category' });
    const noFunds = await fundsError(paidFrom, amt);
    if (noFunds) return res.status(400).json({ message: noFunds });

    if (isPurchaseCategory(cat)) {
      if (!mongoose.Types.ObjectId.isValid(purchaseId)) return res.status(400).json({ message: 'Select the purchase bill for this payment' });
      const purchase = await Purchase.findById(purchaseId);
      if (!purchase) return res.status(404).json({ message: 'Purchase bill not found' });
      const row = purchaseRow(purchase);
      if (row.due <= 0) return res.status(400).json({ message: `Purchase ${row.billNo} is already fully paid` });
      const err = purchasePaymentError({ amount: amt, paidFrom }, row.due);
      if (err) return res.status(400).json({ message: `${err} on ${row.billNo}` });
      const expense = await payPurchase(purchase, { amount: amt, paidFrom, reference, description, paidTo, expenseDate, createdBy });
      return res.status(201).json(expense);
    }

    const expense = await Expense.create({
      expenseId: await nextExpenseId(),
      expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
      amount: amt,
      paidFrom,
      category: cat,
      paidTo,
      description,
      reference,
      createdBy
    });
    res.status(201).json(expense);
  } catch (error) {
    res.status(500).json({ message: 'Error saving expense', error: error.message });
  }
};

// Delete an expense; a Purchase expense gives the amount back to the bill's due
exports.deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ message: 'Expense not found' });
    if (expense.purchase) {
      const purchase = await Purchase.findById(expense.purchase);
      if (purchase) {
        purchase.amountPaid = round2(Math.max(purchasePaid(purchase) - expense.amount, 0));
        await purchase.save();
      }
    }
    await Expense.findByIdAndDelete(expense._id);
    res.json({ message: 'Expense deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting expense', error: error.message });
  }
};
