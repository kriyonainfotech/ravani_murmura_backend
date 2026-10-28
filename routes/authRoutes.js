const express = require('express');
const router = express.Router();
const { superAdminLogin, storeLogin, login } = require('../controllers/authController');

// Route for Super Admin login
// POST /api/super-admin/login
router.post('/login', superAdminLogin);

// Route for Store login
// POST /api/super-admin/store-login
router.post('/store-login', storeLogin);

// Route for General login
router.post('/general-login', login);

module.exports = router;
