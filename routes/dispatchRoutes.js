const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const dispatchController = require('../controllers/dispatchController');

router.post('/', dispatchController.createReadyDispatch);
router.get('/', dispatchController.getDispatches);
router.get('/ready-stock', dispatchController.getReadyStock);
router.get('/ready-stock/all', dispatchController.getAllReadyStock);
router.get('/history/:id', dispatchController.getDispatchHistoryByReadyStock);


router.put('/ready-stock/:id', protectSuperAdmin, dispatchController.updateReadyStock);
router.delete('/ready-stock/:id', protectSuperAdmin, dispatchController.deleteReadyStock);

router.put('/:id', protectSuperAdmin, dispatchController.updateDispatch);
router.delete('/:id', protectSuperAdmin, dispatchController.deleteDispatch);
module.exports = router;


