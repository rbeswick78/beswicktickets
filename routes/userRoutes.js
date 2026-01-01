const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ensureAuthenticated = require('../middleware/auth');
const checkAdminRole = require('../middleware/authorization');

// Route to create a new user (Admin only)
router.post('/create-user', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const { username, password, role } = req.body;

  try {
    // Check if the username already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).send('Username already exists.');
    }

    const user = new User({ username, password, role });
    await user.save();

    // Emit event to update the user list in real-time
    const io = req.app.get('io');
    io.emit('newUser', { userId: user._id, username: user.username });

    res.send('User created successfully.');
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).send('Internal server error.');
  }
});

// Route to delete a user (Admin only)
router.delete('/:id', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const userId = req.params.id;

  try {
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).send('User not found.');
    }

    if (user.role === 'admin') {
      return res.status(403).send('Cannot delete an admin user.');
    }

    await user.remove();

    // Emit event to update the user list in real-time
    const io = req.app.get('io');
    io.emit('userDeleted', { userId });

    res.send('User deleted successfully.');
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).send('Internal server error.');
  }
});

// Route to add tickets to a user (Admin only)
router.post('/add-tickets', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const { userId, quantity, reason } = req.body;

  try {
    const user = await User.findById(userId);
    await user.addTickets(quantity, reason);

    // Emit event to update the ticket balance in real-time
    const io = req.app.get('io');
    io.emit('ticketUpdate', { userId: user._id, ticketBalance: user.ticketBalance });

    res.send('Tickets added successfully.');
  } catch (err) {
    console.error('Error adding tickets:', err);
    res.status(500).send('Internal server error.');
  }
});

// Route to remove tickets from a user (Admin only)
router.post('/remove-tickets', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const { userId, quantity, reason } = req.body;

  try {
    const user = await User.findById(userId);
    await user.removeTickets(quantity, reason);

    // Emit event to update the ticket balance in real-time
    const io = req.app.get('io');
    io.emit('ticketUpdate', { userId: user._id, ticketBalance: user.ticketBalance });

    res.send('Tickets removed successfully.');
  } catch (err) {
    console.error('Error removing tickets:', err);
    res.status(500).send('Internal server error.');
  }
});

// Route to get user transaction history (Admin only)
router.get('/:id/transactions', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const userId = req.params.id;

  try {
    const user = await User.findById(userId, 'transactions');
    if (!user) {
      return res.status(404).send('User not found.');
    }

    res.json(user.transactions);
  } catch (err) {
    console.error('Error fetching transactions:', err);
    res.status(500).send('Internal server error.');
  }
});

// Route to list all users (Admin only) - Needed for QR code generation
router.get('/list', ensureAuthenticated, checkAdminRole, async (req, res) => {
  try {
    const users = await User.find({}, '_id username');
    res.json(users);
  } catch (err) {
    console.error('Error fetching user list:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
