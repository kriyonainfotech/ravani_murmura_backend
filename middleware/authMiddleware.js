const jwt = require('jsonwebtoken');
const { requestContext } = require('../utils/requestContext');

const readToken = (req) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer')) return null;
  return h.split(' ')[1] || null;
};

// Display name of the logged-in person, used for "who did it" in the audit log
const nameFor = async (decoded) => {
  try {
    const id = decoded.id || decoded.userId || decoded.storeId;
    if (decoded.role === 'store') {
      const s = await require('../models/Store').findById(id).select('name').lean();
      return s?.name || 'Store';
    }
    if (decoded.role === 'packaging') {
      const p = await require('../models/PackagingPanel').findById(id).select('name').lean();
      return p?.name || 'Packaging';
    }
    return 'Admin';
  } catch {
    return decoded.role || 'Unknown';
  }
};

// Any logged-in panel (super admin, store, packaging)
const protect = async (req, res, next) => {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized, no token' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }

  const name = await nameFor(decoded);
  req.user = { ...decoded, id: decoded.id || decoded.userId || decoded.storeId, name };
  // Every DB change made while serving this request is logged with this user
  requestContext.run({ user: req.user, path: req.originalUrl, method: req.method }, () => next());
};

const protectSuperAdmin = (req, res, next) => {
  const finish = () => {
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only Super Admin can do this' });
    }
    next();
  };
  // Already verified by protect()
  if (req.user) return finish();
  protect(req, res, finish);
};

module.exports = { protect, protectSuperAdmin };
