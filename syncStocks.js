require('dotenv').config();
const mongoose = require('mongoose');
const Purchase = require('./models/Purchase');
const Stock = require('./models/Stock');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ravanimurmura')
  .then(async () => {
    console.log('Connected to MongoDB for syncing stocks...');
    
    const completedPurchases = await Purchase.find({ status: 'Completed' });
    let createdCount = 0;
    
    for (const purchase of completedPurchases) {
      const existingStock = await Stock.findOne({ purchaseId: purchase._id });
      if (!existingStock) {
        const stockCount = await Stock.countDocuments();
        const batchId = `BATCH-${(stockCount + 1).toString().padStart(4, '0')}`;
        
        const newStock = new Stock({
          batchId,
          purchaseId: purchase._id,
          productName: purchase.item,
          supplier: purchase.supplier,
          purchaseDate: purchase.purchaseDate,
          purchaseRate: purchase.rate,
          purchasedQuantity: purchase.quantity,
          remainingQuantity: purchase.quantity,
          location: "Shop",
          status: "Available",
          createdBy: purchase.createdBy
        });
        
        await newStock.save();
        createdCount++;
        console.log(`Created stock batch ${batchId} for purchase ${purchase.purchaseId}`);
      }
    }
    
    console.log(`Sync complete. Created ${createdCount} new stock batches.`);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
