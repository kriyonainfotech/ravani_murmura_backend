const mongoose = require('mongoose');

// Money accounts (Cash, Company Bank, Personal Bank). Balance = opening + collections - expenses.
const accountSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  openingBalance: { type: Number, default: 0 },
  openingDate: { type: Date, default: null } // "balance as on" date entered with the opening balance
}, { timestamps: true });

module.exports = mongoose.model('Account', accountSchema);
