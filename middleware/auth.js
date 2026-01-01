function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  // Add debug logging
  console.log('Original URL:', req.originalUrl);
  req.session.returnTo = req.originalUrl;
  console.log('Session returnTo:', req.session.returnTo);
  res.redirect('/auth/login');
}

module.exports = ensureAuthenticated;