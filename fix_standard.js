const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI).then(async () => {
    const MachineRun = require('./models/MachineRun');
    await MachineRun.updateMany({ rollType: 'Standard' }, { $set: { rollType: '' } });
    console.log('Fixed DB');
    process.exit(0);
});
