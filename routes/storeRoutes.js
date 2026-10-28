const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const storeController = require('../controllers/storeController');

// In a real app we'd add an auth middleware here to ensure only Super Admin can access these routes
// router.use(authMiddleware); // Assuming super admin auth middleware

router.post('/', protectSuperAdmin, storeController.createStore);
router.get('/', storeController.getStores);
router.put('/:id', protectSuperAdmin, storeController.updateStore);
router.put('/:id/password', protectSuperAdmin, storeController.changePassword);
router.delete('/:id', protectSuperAdmin, storeController.deleteStore);

module.exports = router;
