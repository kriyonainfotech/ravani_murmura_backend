const mongoose = require('mongoose');
const Stock = require('./models/Stock');
const MachineRun = require('./models/MachineRun');

mongoose.connect('mongodb://127.0.0.1:27017/ravani_murmura')
  .then(async () => {
    const stocks = await Stock.find({});
    for (let stock of stocks) {
      const runs = await MachineRun.find({ stockId: stock._id, status: 'COMPLETED' });
      let consumedRaw = 0;
      let consumedRolls = 0;
      for (let run of runs) {
        consumedRaw += (run.actualRawConsumed || 0);
        consumedRolls += (run.actualRollsConsumed || 0);
      }
      stock.packagingGodownConsumedQuantity = consumedRaw;
      stock.packagingRollConsumedQuantity = consumedRolls;
      
      // Also fix negative reserved quantities if any
      if (stock.packagingGodownReservedQuantity < 0) stock.packagingGodownReservedQuantity = 0;
      if (stock.packagingRollReservedQuantity < 0) stock.packagingRollReservedQuantity = 0;
      
      await stock.save();
    }
    console.log('Done syncing consumed quantities');
    process.exit(0);
  });
