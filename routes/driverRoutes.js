const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driverController');

// All driver routes are protected by server-level auth middleware
router.get('/', driverController.getDrivers);
router.post('/', driverController.createDriver);
router.get('/activity/all', driverController.getAllDriverActivity);
router.delete('/activity/trip/:tripId', driverController.deleteTrip);
router.get('/:id', driverController.getDriverLedger);
router.put('/:id', driverController.updateDriver);
router.delete('/:id', driverController.deleteDriver);

// Driver advance payment sub-routes
router.post('/:id/advance', driverController.addAdvance);
router.delete('/:id/advance/:advanceId', driverController.deleteAdvance);

module.exports = router;
