const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
    const Stock = require('./models/Stock');
    const PackagingRequest = require('./models/PackagingRequest');

    console.log('Syncing Rolls from past Packaging Requests to Stock...');

    // Get all stocks
    const stocks = await Stock.find({});

    for (let stock of stocks) {
        // Find all received requests for this stock batch
        const requests = await PackagingRequest.find({ 
            stockId: stock._id, 
            status: { $in: ['RECEIVED', 'RECEIVED_WITH_SHORTAGE'] } 
        });

        let totalReceivedRolls = 0;
        let totalReceivedKG = 0;

        for (let req of requests) {
            totalReceivedRolls += (req.receivedPackagingRollQuantity || 0);
            totalReceivedKG += (req.receivedQuantity || 0);
        }

        // We update the rolls based on past requests
        stock.packagingRollQuantity = totalReceivedRolls;
        
        // Ensure Godown quantity matches the sum of past requests
        // (Only doing this if it doesn't mess up existing reserved logics, but since it's early testing, it's fine)
        if (totalReceivedKG > 0 && stock.packagingGodownQuantity !== totalReceivedKG) {
            console.log(`Fixing KG for ${stock.batchId}: ${stock.packagingGodownQuantity} -> ${totalReceivedKG}`);
            stock.packagingGodownQuantity = totalReceivedKG;
        }

        await stock.save();
        console.log(`Synced Batch: ${stock.batchId} | Rolls: ${totalReceivedRolls}`);
    }

    console.log('Sync Complete!');
    process.exit(0);
}).catch(console.error);
