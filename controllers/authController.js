const User = require('../models/User');
const Store = require('../models/Store');
const PackagingPanel = require('../models/PackagingPanel');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Access denied. Super Admin only.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
};

exports.storeLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const store = await Store.findOne({ email });
    if (!store) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!store.isActive) {
      return res.status(403).json({ success: false, message: 'Store account is deactivated.' });
    }

    const isMatch = await bcrypt.compare(password, store.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { storeId: store._id, role: store.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: store._id,
        email: store.email,
        name: store.name,
        role: store.role
      }
    });

  } catch (error) {
    console.error('Store login error:', error);
    res.status(500).json({ success: false, message: 'Server error during store login' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    let user = await User.findOne({ email });
    let isMatch = false;

    if (user) {
      isMatch = await bcrypt.compare(password, user.password);
    } else {
      user = await Store.findOne({ email });
      if (user) {
        if (!user.isActive) {
          return res.status(403).json({ success: false, message: 'Account is deactivated.' });
        }
        isMatch = await bcrypt.compare(password, user.password);
      } else {
        user = await PackagingPanel.findOne({ email });
        if (user) {
          if (!user.isActive) {
            return res.status(403).json({ success: false, message: 'Account is deactivated.' });
          }
          isMatch = await bcrypt.compare(password, user.password);
        }
      }
    }

    if (!user || !isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        name: user.name
      }
    });

  } catch (error) {
    console.error('Unified login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
};
