const express = require('express');
const router = express.Router();
const { protect, protectSuperAdmin } = require('../middleware/authMiddleware');
const dispatchController = require('../controllers/dispatchController');

router.post('/', dispatchController.createReadyDispatch);
router.get('/', dispatchController.getDispatches);
router.get('/next-challan-id', dispatchController.getNextChallanIdEndpoint);
router.get('/ready-stock', dispatchController.getReadyStock);
router.get('/ready-stock/all', dispatchController.getAllReadyStock);
router.get('/history/:id', dispatchController.getDispatchHistoryByReadyStock);


router.put('/ready-stock/:id', protect, dispatchController.updateReadyStock);
router.delete('/ready-stock/:id', protect, dispatchController.deleteReadyStock);

router.put('/:id', protect, dispatchController.updateDispatch);
router.delete('/:id', protect, dispatchController.deleteDispatch);
module.exports = router;



