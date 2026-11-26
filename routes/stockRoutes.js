const express = require('express');
const router = express.Router();
const { protect, protectSuperAdmin } = require('../middleware/authMiddleware');
const stockController = require('../controllers/stockController');

router.get('/', stockController.getStocks);
router.get('/costing', stockController.getCostingReport);
router.get('/:id', stockController.getStockById);
router.get('/product/:productName', stockController.getStocksByProduct);
router.put('/:id', protect, stockController.updateStock);
router.delete('/:id', protect, stockController.deleteStock);

module.exports = router;
