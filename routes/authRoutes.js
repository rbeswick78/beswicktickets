const express = require('express');
const router = express.Router();
const passport = require('passport');
const path = require('path');

// Render login page
router.get('/login', (req, res) => {
  res.render('login', { 
    returnTo: req.session.returnTo || '/admin'
  });
});

// Handle login form submission with custom callback
router.post('/login', (req, res, next) => {
  console.log('1. Login route hit');
  console.log('Initial session:', req.session);
  
  passport.authenticate('local', (err, user) => {
    console.log('2. Inside passport.authenticate callback');
    if (err) {
      console.log('3A. Authentication error:', err);
      return next(err);
    }
    if (!user) {
      console.log('3B. No user found');
      return res.redirect('/auth/login');
    }

    console.log('3C. User found:', user.username);
    req.logIn(user, (loginErr) => {
      console.log('4. Inside logIn callback');
      if (loginErr) {
        console.log('4A. Login error:', loginErr);
        return next(loginErr);
      }

      console.log('4B. Login successful');
      console.log('Session returnTo:', req.session.returnTo);
      // Always check returnTo first, fall back to a role-appropriate default
      const redirectTo = req.session.returnTo || (user.role === 'admin' ? '/admin' : '/srm');
      console.log('Redirecting to:', redirectTo);
      delete req.session.returnTo;
      return res.redirect(redirectTo);
    });
  })(req, res, next);
});

// Handle logout
router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;