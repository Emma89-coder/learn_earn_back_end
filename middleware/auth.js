// backend/middleware/auth.js
const jwt = require('jsonwebtoken');

// Middleware to authenticate JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const role = String(req.user.role || '').toLowerCase();
  if (role.includes('admin')) {
    next();
  } else {
    return res.status(403).json({ error: 'Access denied. Admin only.' });
  }
};

// Middleware to check if user is a learner
const isLearner = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.user.role && req.user.role.toLowerCase() === 'learner') {
    next();
  } else {
    return res.status(403).json({ error: 'Access denied. Learners only.' });
  }
};

module.exports = { 
  authenticateToken, 
  isAdmin,
  isLearner
};