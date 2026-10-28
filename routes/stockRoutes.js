const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const stockController = require('../controllers/stockController');
// const { verifyToken } = require('../middleware/authMiddleware'); // Uncomment if using auth middleware globally or per route

router.get('/', stockController.getStocks);
router.get('/costing', stockController.getCostingReport);
router.get('/:id', stockController.getStockById);
router.get('/product/:productName', stockController.getStocksByProduct);
router.put('/:id', protectSuperAdmin, stockController.updateStock);
router.delete('/:id', protectSuperAdmin, stockController.deleteStock);

module.exports = router;
