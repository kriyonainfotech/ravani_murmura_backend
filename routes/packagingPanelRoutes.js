const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const packagingPanelController = require('../controllers/packagingPanelController');

router.post('/', packagingPanelController.createPanel);
router.get('/', packagingPanelController.getPanels);
router.put('/:id', packagingPanelController.updatePanel);
router.put('/:id/password', packagingPanelController.changePassword);
router.delete('/:id', protectSuperAdmin, packagingPanelController.deletePanel);

module.exports = router;
