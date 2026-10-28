const mongoose = require('mongoose');
const ReadyStock = require('./models/ReadyStock');
const MachineRun = require('./models/MachineRun');
require('dotenv').config({ path: './.env' });
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ravani-murmura').then(async () => {
    const rs = await ReadyStock.findOne({ productionBatchId: 'PB-1791550208429' });
    console.log(rs);
    const run = await MachineRun.findById(rs.machineRunId);
    console.log(run);
    process.exit(0);
});
