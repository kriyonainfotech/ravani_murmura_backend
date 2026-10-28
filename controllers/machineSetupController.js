const Machine = require('../models/Machine');
const MachineRun = require('../models/MachineRun');

const ACTIVE_STATUSES = ['RUNNING', 'PAUSED'];

// The app used fixed machines "1" and "2" before machines could be created,
// so seed them once to keep old runs linked to a machine.
const seedDefaultMachines = async () => {
  const count = await Machine.countDocuments();
  if (count > 0) return;
  await Machine.insertMany([
    { code: '1', name: 'Machine 1', createdBy: 'system' },
    { code: '2', name: 'Machine 2', createdBy: 'system' }
  ]);
};

exports.getMachines = async (req, res) => {
  try {
    await seedDefaultMachines();
    const machines = await Machine.find().sort({ code: 1 });
    res.status(200).json(machines);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createMachine = async (req, res) => {
  try {
    const { code, name, description, isActive, panelId, createdBy } = req.body;
    if (!code || !String(code).trim() || !name || !String(name).trim()) {
      return res.status(400).json({ message: 'Machine number and name are required' });
    }
    const exists = await Machine.findOne({ code: String(code).trim() });
    if (exists) return res.status(400).json({ message: `Machine number ${code} already exists` });

    const machine = await Machine.create({
      code: String(code).trim(),
      name: String(name).trim(),
      description: description || '',
      isActive: isActive !== false,
      panelId: panelId || undefined,
      createdBy
    });
    res.status(201).json(machine);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateMachine = async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (!machine) return res.status(404).json({ message: 'Machine not found' });

    const { name, description, isActive } = req.body;
    // The number is the link to past runs, so it cannot be changed once used
    if (req.body.code !== undefined && String(req.body.code).trim() !== machine.code) {
      const used = await MachineRun.exists({ machineNumber: machine.code });
      if (used) return res.status(400).json({ message: 'Machine number cannot be changed after it has been used in a run' });
      const clash = await Machine.findOne({ code: String(req.body.code).trim() });
      if (clash) return res.status(400).json({ message: `Machine number ${req.body.code} already exists` });
      machine.code = String(req.body.code).trim();
    }
    if (isActive === false) {
      const running = await MachineRun.exists({ machineNumber: machine.code, status: { $in: ACTIVE_STATUSES } });
      if (running) return res.status(400).json({ message: 'Complete or cancel the current run before turning this machine off' });
    }
    if (name !== undefined) machine.name = String(name).trim();
    if (description !== undefined) machine.description = description;
    if (isActive !== undefined) machine.isActive = isActive;
    await machine.save();
    res.json(machine);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteMachine = async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (!machine) return res.status(404).json({ message: 'Machine not found' });
    const running = await MachineRun.exists({ machineNumber: machine.code, status: { $in: ACTIVE_STATUSES } });
    if (running) return res.status(400).json({ message: 'This machine has a run in progress. Complete or cancel it first.' });
    await machine.deleteOne();
    res.json({ message: 'Machine deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
