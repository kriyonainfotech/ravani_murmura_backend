const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const financeController = require('../controllers/financeController');

router.get('/sale-book', financeController.getSaleBook);
router.get('/purchase-book', financeController.getPurchaseBook);
router.get('/party-dues', financeController.getPartyDues);

router.get('/payments', financeController.getPayments);
router.post('/payments', financeController.createPayment);
router.delete('/payments/:id', protectSuperAdmin, financeController.deletePayment);

router.get('/accounts', financeController.getAccounts);
router.put('/accounts/opening', protectSuperAdmin, financeController.setOpeningBalances);
router.get('/accounts/:name/ledger', financeController.getAccountLedger);

router.get('/expense-categories', financeController.getExpenseCategories);
router.get('/expenses', financeController.getExpenses);
router.post('/expenses', financeController.createExpense);
router.delete('/expenses/:id', protectSuperAdmin, financeController.deleteExpense);

module.exports = router;
