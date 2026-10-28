const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const auditController = require('../controllers/auditController');

// Read-only: the audit log is never edited or deleted from the app
router.get('/', protectSuperAdmin, auditController.getLogs);
router.get('/batch/:batchId', auditController.getBatchTimeline);

module.exports = router;
