const mongoose = require('mongoose');
const ReadyStock = require('./models/ReadyStock');
const PackagingDispatch = require('./models/PackagingDispatch');
require('dotenv').config({ path: './.env' });

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ravani-murmura')
  .then(async () => {
    const readyStocks = await ReadyStock.find();
    for (let rs of readyStocks) {
      const dispatches = await PackagingDispatch.find({ readyStockId: rs._id });
      let totalDispatchedPackets = 0;
      let totalDispatchedWeightKg = 0;
      for (let d of dispatches) {
        totalDispatchedPackets += d.packetsToDispatch;
        totalDispatchedWeightKg += d.weightToDispatchKg;
      }
      
      const availablePackets = rs.totalPackets - totalDispatchedPackets;
      const availableWeightKg = rs.totalWeightKg - totalDispatchedWeightKg;
      
      rs.dispatchedPackets = totalDispatchedPackets;
      rs.dispatchedWeightKg = totalDispatchedWeightKg;
      rs.availablePackets = availablePackets;
      rs.availableWeightKg = availableWeightKg;
      await rs.save();
    }
    console.log('Fix applied');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
