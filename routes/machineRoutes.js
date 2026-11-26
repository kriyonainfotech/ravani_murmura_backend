const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const machineController = require('../controllers/machineController');

router.post('/start', machineController.startMachine);
router.get('/active', machineController.getActiveRuns);
router.post('/:id/mount-roll', machineController.mountRoll);
router.get('/history', machineController.getRunHistory);
router.get('/history/stock/:stockId', machineController.getRunHistoryByStock);
router.get('/history/product/:productName', machineController.getRunHistoryByProduct);
router.put('/:id/complete', machineController.completeRun);
router.put('/:id/cancel', machineController.cancelRun);
router.put('/:id/pause', machineController.pauseRun);
router.put('/:id/resume', machineController.resumeRun);


router.put('/:id', machineController.updateRun);
router.delete('/:id', machineController.deleteRun);
module.exports = router;

