const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const saleController = require('../controllers/saleController');

router.get('/available-stock', saleController.getAvailableStockForSale);
router.get('/store-inventory', saleController.getStoreInventory);
router.put('/store-stock/:id', protectSuperAdmin, saleController.updateShopStock);
router.delete('/store-stock/:id', protectSuperAdmin, saleController.deleteShopStock);
router.put('/confirm-dispatch/:id', saleController.confirmDispatchReceived);
router.get('/stats', saleController.getSalesStats);
router.get('/customers', saleController.getCustomers);
router.get('/', saleController.getSales);
router.get('/:id', saleController.getSaleById);
router.post('/', saleController.createSale);
router.delete('/:id', protectSuperAdmin, saleController.deleteSale);

module.exports = router;
