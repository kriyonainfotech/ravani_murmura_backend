const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const purchaseController = require('../controllers/purchaseController');

// We are currently not verifying tokens for all routes to keep it simple, 
// but we should add auth middleware if needed.

router.get('/', purchaseController.getPurchases);
router.post('/', purchaseController.addPurchase);
router.delete('/:id', protectSuperAdmin, purchaseController.deletePurchase);
router.patch('/:id/status', purchaseController.updatePurchaseStatus);

router.put('/:id', protectSuperAdmin, purchaseController.updatePurchase);

module.exports = router;
