
const express = require('express');
const router = express.Router();
const { protect, protectSuperAdmin } = require('../middleware/authMiddleware');
const settingsController = require('../controllers/settingsController');

router.get('/products', settingsController.getProducts);
router.post('/products', protect, settingsController.addProduct);
router.put('/products/:id', protect, settingsController.updateProduct);
router.delete('/products/:id', protectSuperAdmin, settingsController.deleteProduct);

router.post('/recalculate-costs', protectSuperAdmin, settingsController.recalculateCosts);

router.get('/distinct-products', settingsController.getDistinctProducts);
module.exports = router;
