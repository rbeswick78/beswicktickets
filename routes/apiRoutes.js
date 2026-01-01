const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const ensureAuthenticated = require('../middleware/auth');
const checkAdminRole = require('../middleware/authorization');

// API endpoint to get list of users excluding admins
router.get('/users', userController.getPublicUsers.bind(userController));

// API endpoint to add tickets to a user
router.post('/users/add-tickets', ensureAuthenticated, checkAdminRole, userController.addTickets.bind(userController));

// API endpoint to remove tickets from a user
router.post('/users/remove-tickets', ensureAuthenticated, checkAdminRole, userController.removeTickets.bind(userController));

// API endpoint to get a user's transactions
router.get(
  '/users/:userId/transactions',
  ensureAuthenticated,
  checkAdminRole,
  userController.getUserTransactions.bind(userController)
);

// API endpoint to delete a user
router.delete(
  '/users/:userId',
  ensureAuthenticated,
  checkAdminRole,
  userController.deleteUser.bind(userController)
);

module.exports = router;