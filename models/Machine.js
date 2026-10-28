const mongoose = require('mongoose');

// A physical packaging machine. Machine runs reference it through `code`
// (stored on MachineRun.machineNumber), so existing runs keep working.
const machineSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  panelId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackagingPanel' },
  createdBy: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Machine', machineSchema);
