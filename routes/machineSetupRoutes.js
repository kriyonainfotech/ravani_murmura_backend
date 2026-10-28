const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const machineSetupController = require('../controllers/machineSetupController');

router.get('/', machineSetupController.getMachines);
router.post('/', machineSetupController.createMachine);
router.put('/:id', machineSetupController.updateMachine);
router.delete('/:id', protectSuperAdmin, machineSetupController.deleteMachine);

module.exports = router;
