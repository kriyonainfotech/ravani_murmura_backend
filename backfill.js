const mongoose = require('mongoose');
const MachineRun = require('./models/MachineRun');
const ReadyStock = require('./models/ReadyStock');
const PackagingDispatch = require('./models/PackagingDispatch');
require('dotenv').config({ path: './.env' });

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ravani-murmura')
  .then(async () => {
    const readyStocks = await ReadyStock.find().populate('machineRunId');
    for (let rs of readyStocks) {
      if (rs.machineRunId && rs.machineRunId.stockBatchId) {
        rs.stockBatchId = rs.machineRunId.stockBatchId;
        await rs.save();
      }
    }
    const dispatches = await PackagingDispatch.find();
    for (let d of dispatches) {
      const rs = await ReadyStock.findById(d.readyStockId);
      if (rs && rs.stockBatchId) {
        d.stockBatchId = rs.stockBatchId;
        await d.save();
      }
    }
    console.log('Backfill applied');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
