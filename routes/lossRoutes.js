const express = require('express');
const router = express.Router();
const lossController = require('../controllers/lossController');
const { protectSuperAdmin } = require('../middleware/authMiddleware');

// Read access for every panel (stage forms need reasons and limits)
router.get('/config', lossController.getConfig);
router.get('/pending-count', lossController.getPendingCount);
router.get('/entries', lossController.getEntries);
router.get('/filters', lossController.getFilterOptions);
router.get('/reports/:type', lossController.getReport);
router.get('/entries/:id/photo', lossController.getPhoto);
router.put('/entries/:id/photo', lossController.setPhoto); // any panel can attach proof

// Only the super admin changes limits and approves / rejects
router.put('/config', protectSuperAdmin, lossController.updateConfig);
router.put('/entries/:id/approve', protectSuperAdmin, lossController.approveEntry);
router.put('/entries/:id/reject', protectSuperAdmin, lossController.rejectEntry);
router.post('/backfill', protectSuperAdmin, lossController.backfill);

module.exports = router;
