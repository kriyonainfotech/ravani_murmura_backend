const express = require('express');
const router = express.Router();
const { protect, protectSuperAdmin } = require('../middleware/authMiddleware');
const saleController = require('../controllers/saleController');

router.get('/available-stock', saleController.getAvailableStockForSale);
router.get('/store-inventory', saleController.getStoreInventory);
router.put('/store-stock/:id', protect, saleController.updateShopStock);
router.delete('/store-stock/:id', protect, saleController.deleteShopStock);
router.put('/confirm-dispatch/:id', saleController.confirmDispatchReceived);
router.get('/stats', saleController.getSalesStats);
router.get('/customers', saleController.getCustomers);
router.get('/', saleController.getSales);
router.get('/:id', saleController.getSaleById);
router.post('/', saleController.createSale);
router.delete('/:id', protect, saleController.deleteSale);

module.exports = router;
