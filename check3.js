const mongoose = require('mongoose');
const Stock = require('./models/Stock');
require('dotenv').config({ path: './.env' });
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ravani-murmura').then(async () => {
    const s = await Stock.find();
    console.log(s.map(x => x.batchId));
    process.exit(0);
});
