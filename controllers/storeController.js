const Store = require('../models/Store');
const bcrypt = require('bcryptjs');

// Create a new store
exports.createStore = async (req, res) => {
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

    // Check if store already exists
    const existingStore = await Store.findOne({ email });
    if (existingStore) {
      return res.status(400).json({ success: false, message: 'Store email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create store
    const store = new Store({
      name,
      email,
      password: hashedPassword,
      mobileNumber
    });

    await store.save();

    res.status(201).json({ 
      success: true, 
      message: 'Store created successfully', 
      store: { 
        id: store._id, 
        name: store.name, 
        email: store.email, 
        mobileNumber: store.mobileNumber,
        isActive: store.isActive 
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error creating store', error: error.message });
  }
};

// Get all stores
exports.getStores = async (req, res) => {
  try {
    const stores = await Store.find().select('-password').sort({ createdAt: -1 });
    res.status(200).json(stores);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stores', error: error.message });
  }
};

// Update store details
exports.updateStore = async (req, res) => {
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

    // Check if another store has this email
    if (email) {
        const existingStore = await Store.findOne({ email, _id: { $ne: id } });
        if (existingStore) {
            return res.status(400).json({ success: false, message: 'Store email already taken' });
        }
    }

    const updatedStore = await Store.findByIdAndUpdate(
      id,
      { name, email, mobileNumber, isActive },
      { new: true }
    ).select('-password');

    if (!updatedStore) {
      return res.status(404).json({ message: 'Store not found' });
    }

    res.status(200).json({ success: true, message: 'Store updated successfully', store: updatedStore });
  } catch (error) {
    res.status(500).json({ message: 'Error updating store', error: error.message });
  }
};

// Change store password
exports.changePassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const updatedStore = await Store.findByIdAndUpdate(
      id,
      { password: hashedPassword },
      { new: true }
    );

    if (!updatedStore) {
      return res.status(404).json({ message: 'Store not found' });
    }

    res.status(200).json({ success: true, message: 'Store password changed successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error changing password', error: error.message });
  }
};

// Delete a store
exports.deleteStore = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedStore = await Store.findByIdAndDelete(id);
    
    if (!deletedStore) {
      return res.status(404).json({ message: 'Store not found' });
    }
    
    res.status(200).json({ success: true, message: 'Store deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting store', error: error.message });
  }
};
