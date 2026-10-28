const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI).then(async () => {
    const Stock = require('./models/Stock');
    await Stock.updateMany({}, { $set: { packagingRollQuantity: 10 } });
    console.log('Fixed DB');
    process.exit(0);
});
