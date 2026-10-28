const PackagingPanel = require('../models/PackagingPanel');
const bcrypt = require('bcryptjs');

// Create a new panel
exports.createPanel = async (req, res) => {
  try {
    const { name, email, password, mobileNumber } = req.body;

    // Validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    const mobileRegex = /^[0-9]{10}$/;
    if (!mobileRegex.test(mobileNumber)) {
      return res.status(400).json({ success: false, message: 'Mobile number must be 10 digits' });
    }

    // Check if panel already exists
    const existingPanel = await PackagingPanel.findOne({ email });
    if (existingPanel) {
      return res.status(400).json({ success: false, message: 'Packaging Panel email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create panel
    const panel = new PackagingPanel({
      name,
      email,
      password: hashedPassword,
      mobileNumber
    });

    await panel.save();

    res.status(201).json({ 
      success: true, 
      message: 'Packaging Panel created successfully', 
      panel: { 
        id: panel._id, 
        name: panel.name, 
        email: panel.email, 
        mobileNumber: panel.mobileNumber,
        isActive: panel.isActive,
        role: panel.role
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating packaging panel', error: error.message });
  }
};

// Get all panels
exports.getPanels = async (req, res) => {
  try {
    const panels = await PackagingPanel.find().select('-password').sort({ createdAt: -1 });
    res.status(200).json(panels);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching packaging panels', error: error.message });
  }
};

// Update panel details
exports.updatePanel = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, mobileNumber, isActive } = req.body;

    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Invalid email format' });
      }
    }

    if (mobileNumber) {
      const mobileRegex = /^[0-9]{10}$/;
      if (!mobileRegex.test(mobileNumber)) {
        return res.status(400).json({ success: false, message: 'Mobile number must be 10 digits' });
      }
    }

    // Check if another panel has this email
    if (email) {
        const existingPanel = await PackagingPanel.findOne({ email, _id: { $ne: id } });
        if (existingPanel) {
            return res.status(400).json({ success: false, message: 'Packaging Panel email already taken' });
        }
    }

    const updatedPanel = await PackagingPanel.findByIdAndUpdate(
      id,
      { name, email, mobileNumber, isActive },
      { new: true }
    ).select('-password');

    if (!updatedPanel) {
      return res.status(404).json({ message: 'Packaging Panel not found' });
    }

    res.status(200).json({ success: true, message: 'Packaging Panel updated successfully', panel: updatedPanel });
  } catch (error) {
    res.status(500).json({ message: 'Error updating packaging panel', error: error.message });
  }
};

// Change panel password
exports.changePassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const updatedPanel = await PackagingPanel.findByIdAndUpdate(
      id,
      { password: hashedPassword },
      { new: true }
    );

    if (!updatedPanel) {
      return res.status(404).json({ message: 'Packaging Panel not found' });
    }

    res.status(200).json({ success: true, message: 'Packaging Panel password changed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error changing password', error: error.message });
  }
};

// Delete a panel
exports.deletePanel = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPanel = await PackagingPanel.findByIdAndDelete(id);
    
    if (!deletedPanel) {
      return res.status(404).json({ message: 'Packaging Panel not found' });
    }
    
    res.status(200).json({ success: true, message: 'Packaging Panel deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting packaging panel', error: error.message });
  }
};
