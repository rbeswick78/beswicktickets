const express = require('express');
const router = express.Router();
const path = require('path');
const ensureAuthenticated = require('../middleware/auth');
const checkAdminRole = require('../middleware/authorization');

// Render admin page at '/admin'
router.get('/', ensureAuthenticated, checkAdminRole, (req, res) => {
  res.sendFile(path.join(__dirname, '../views/admin.html'));
});

module.exports = router;