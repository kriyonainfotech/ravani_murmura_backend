const mongoose = require('mongoose');
const ReadyStock = require('./models/ReadyStock');
require('dotenv').config({ path: './.env' });
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ravani-murmura').then(async () => {
    const rs = await ReadyStock.find();
    console.log('Total:', rs.length);
    console.log('Without stockBatchId:', rs.filter(r => !r.stockBatchId).length);
    for (let r of rs.filter(r => !r.stockBatchId)) {
        console.log(r.productionBatchId, r.stockBatchId);
    }
    process.exit(0);
});
