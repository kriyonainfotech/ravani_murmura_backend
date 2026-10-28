const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const trackingController = require('../controllers/trackingController');

// Reading is open to every logged-in panel; corrections are Super Admin only
router.get('/master', trackingController.getMasterTracking);


router.put('/master/:batchId', protectSuperAdmin, trackingController.updateBatch);
router.delete('/master/:batchId', protectSuperAdmin, trackingController.deleteBatch);

module.exports = router;

