require('dotenv').config();
const mongoose = require('mongoose');
const Purchase = require('./models/Purchase');
const Stock = require('./models/Stock');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const purchases = await Purchase.find({}, '_id');
  const purchaseIds = purchases.map(p => p._id);
  const deleted = await Stock.deleteMany({ purchaseId: { $nin: purchaseIds } });
  console.log('Deleted orphaned stocks:', deleted.deletedCount);
  mongoose.disconnect();
});
