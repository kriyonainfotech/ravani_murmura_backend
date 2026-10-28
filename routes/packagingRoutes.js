const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middleware/authMiddleware');
const packagingController = require('../controllers/packagingController');

router.post('/dispatch', packagingController.createDispatch);
router.get('/requests', packagingController.getRequests);
router.get('/requests/:id', packagingController.getRequestById);
router.put('/requests/:id/receive', packagingController.receiveRequest);

router.delete('/requests/:id', protectSuperAdmin, packagingController.deleteRequest);

module.exports = router;

router.get('/godown', packagingController.getGodownStock);
router.get('/godown/history', packagingController.getGodownHistory);
