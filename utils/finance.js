const Payment = require('../models/Payment');
const Expense = require('../models/Expense');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Old sale bills have no amountPaid yet: a 'Paid' bill counts as fully paid, anything else as nothing paid
const salePaid = (sale) => (sale.amountPaid != null
  ? Number(sale.amountPaid) || 0
  : (sale.paymentStatus === 'Paid' ? Number(sale.finalAmount) || 0 : 0));

const purchasePaid = (purchase) => Number(purchase.amountPaid) || 0;

const statusFor = (paid, total) => {
  if (total > 0 && paid >= total - 0.005) return 'Paid';
  if (paid > 0) return 'Partial';
  return 'Pending';
};

const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'];

// Money accounts: collections go into one, expenses are paid from one
const ACCOUNTS = ['Cash', 'Company Bank', 'Personal Bank'];
// Cash payments land in Cash, anything digital in the company bank
const accountForMode = (mode) => (mode === 'Cash' ? 'Cash' : 'Company Bank');
const DEFAULT_EXPENSE_CATEGORIES = ['Purchase', 'Operational', 'Salary / Payout', 'Other'];

// Next number after the latest id with this prefix (RCV-0001, EXP-0001)
const nextId = async (Model, field, prefix) => {
  const last = await Model.findOne({ [field]: new RegExp(`^${prefix}`) }).sort({ createdAt: -1 });
  const lastNum = last ? parseInt(last[field].replace(prefix, ''), 10) : 0;
  return `${prefix}${String((Number.isNaN(lastNum) ? 0 : lastNum) + 1).padStart(4, '0')}`;
};
const nextPaymentId = () => nextId(Payment, 'paymentId', 'RCV-');
const nextExpenseId = () => nextId(Expense, 'expenseId', 'EXP-');

// Called right after a sale bill is saved: a bill marked Paid gets its full payment logged as a collection
const recordSaleAtBilling = async (sale) => {
  if (sale.paymentStatus !== 'Paid' || !(sale.finalAmount > 0)) {
    sale.amountPaid = 0;
    await sale.save();
    return;
  }
  await Payment.create({
    paymentId: await nextPaymentId(),
    type: 'IN',
    sale: sale._id,
    billNo: sale.saleId,
    partyName: sale.customerName || 'Walk-in Customer',
    amount: round2(sale.finalAmount),
    mode: PAYMENT_MODES.includes(sale.paymentMode) ? sale.paymentMode : 'Other',
    account: accountForMode(sale.paymentMode),
    paymentDate: sale.saleDate || new Date(),
    notes: 'Paid at billing',
    createdBy: sale.createdBy || 'Admin'
  });
  sale.amountPaid = round2(sale.finalAmount);
  await sale.save();
};

// Check a supplier payment before anything is saved. Returns an error message or null.
// `due` = what is still unpaid on the bill (after any change being made in the same request).
const purchasePaymentError = (payment, due) => {
  const amt = round2(payment?.amount);
  if (!(amt > 0)) return null; // nothing paid now
  if (!ACCOUNTS.includes(payment.paidFrom)) return 'Paid From must be Cash, Company Bank or Personal Bank';
  if (amt > round2(due) + 0.005) return `Paid amount is more than the due ₹${round2(due)}`;
  return null;
};

// Money in an account right now: opening + collections received in it - expenses paid from it
const accountBalance = async (name) => {
  const Account = require('../models/Account');
  const [saved, ins, outs] = await Promise.all([
    Account.findOne({ name }),
    Payment.aggregate([{ $match: { account: name } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { paidFrom: name } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
  ]);
  return round2((saved?.openingBalance || 0) + (ins[0]?.total || 0) - (outs[0]?.total || 0));
};

// An account cannot pay more than it holds. Returns an error message or null.
const fundsError = async (paidFrom, amount) => {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const balance = await accountBalance(paidFrom);
  if (amt > balance + 0.005) {
    return `${paidFrom} has only ₹${balance}. Pay from another account, pay less, or add money to ${paidFrom} (opening balance).`;
  }
  return null;
};

// Pay a supplier against a purchase bill: adds a 'Purchase' expense and counts it as paid on the bill.
// Validate with purchasePaymentError first; returns the expense, or null when amount is 0.
const payPurchase = async (purchase, { amount, paidFrom, reference = '', description = '', paidTo = '', expenseDate, createdBy = 'Admin' }) => {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const expense = await Expense.create({
    expenseId: await nextExpenseId(),
    expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
    amount: amt,
    paidFrom,
    category: 'Purchase',
    purchase: purchase._id,
    billNo: purchase.purchaseId,
    paidTo: paidTo || purchase.supplier,
    description,
    reference,
    createdBy
  });
  purchase.amountPaid = round2(purchasePaid(purchase) + amt);
  await purchase.save();
  return expense;
};

// Sale bills from before payments were tracked: give each a collection entry so account balances
// and the Collection list include them. Safe to run again (only touches bills with no amountPaid yet).
const backfillSalePayments = async () => {
  const Sale = require('../models/Sale');
  const old = await Sale.find({ amountPaid: null });
  for (const sale of old) await recordSaleAtBilling(sale);
  if (old.length) console.log(`Finance: added collection entries for ${old.length} older sale bills`);
};

module.exports = {
  round2, salePaid, purchasePaid, statusFor, PAYMENT_MODES, ACCOUNTS, accountForMode, DEFAULT_EXPENSE_CATEGORIES,
  nextPaymentId, nextExpenseId, recordSaleAtBilling, backfillSalePayments, purchasePaymentError, payPurchase,
  accountBalance, fundsError
};
