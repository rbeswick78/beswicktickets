function checkAdminRole(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).send('Access denied');
}

module.exports = checkAdminRole;