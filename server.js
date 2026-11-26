const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Audit log on every model: must be registered before any model is required
mongoose.plugin(require('./utils/auditPlugin'));
const { protect } = require('./middleware/authMiddleware');

const authRoutes = require('./routes/authRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const purchaseRoutes = require('./routes/purchaseRoutes');
const storeRoutes = require('./routes/storeRoutes');
const User = require('./models/User');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '6mb' })); // loss entry photos come in as base64

// API data changes all the time: never let the browser serve it from its cache
app.set('etag', false);
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const stockRoutes = require('./routes/stockRoutes');
const packagingPanelRoutes = require('./routes/packagingPanelRoutes');

// Routes
app.use('/api/super-admin', authRoutes); // login routes stay open

// Health check route
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is healthy' });
});

// Everything below needs a logged-in panel (super admin / store / packaging)
app.use('/api', protect);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/packaging', require('./routes/packagingRoutes'));
app.use('/api/packaging-panels', packagingPanelRoutes);
app.use('/api/machine', require('./routes/machineRoutes'));
app.use('/api/machines', require('./routes/machineSetupRoutes'));
app.use('/api/dispatch', require('./routes/dispatchRoutes'));
app.use('/api/tracking', require('./routes/masterTrackingRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/sales', require('./routes/saleRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/loss', require('./routes/lossRoutes'));
app.use('/api/finance', require('./routes/financeRoutes'));
app.use('/api/team', require('./routes/teamRoutes'));
app.use('/api/drivers', require('./routes/driverRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));

// Database connection and Super Admin Seeding
mongoose.connect(process.env.MONGO_URI).then(async () => {
    console.log('Connected to MongoDB');
    await require('./utils/finance').backfillSalePayments()
        .catch(err => console.error('Finance backfill failed:', err.message));
    
    // Seed Super Admin if it doesn't exist
    const adminEmail = process.env.SUPER_ADMIN_EMAIL;
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD;

    if (adminEmail && adminPassword) {
        const adminExists = await User.findOne({ email: adminEmail });
        if (!adminExists) {
            console.log('Super Admin not found. Creating one...');
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(adminPassword, salt);
            
            await User.create({
                email: adminEmail,
                password: hashedPassword,
                role: 'super_admin'
            });
            console.log('Super Admin created successfully!');
        } else {
            console.log('Super Admin already exists.');
        }
    }

}).catch((error) => {
    console.error('MongoDB connection error:', error);
});

// Local: start the server. On Vercel the exported app is used instead.
if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

module.exports = app;
