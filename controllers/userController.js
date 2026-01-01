const User = require('../models/User');

class UserController {
  // Method to create a new user (admin only)
  async createUser(req, res) {
    try {
      const { username, password, role } = req.body;

      // Only admin can create users with 'admin' role
      if (role === 'admin' && req.user.role !== 'admin') {
        return res.status(403).send('Access denied');
      }

      // Check if username already exists
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).send('Username already exists');
      }

      const newUser = new User({ username, password, role });
      await newUser.save();

      // Emit socket event for new user creation
      req.app.get('io').emit('newUser', {
        _id: newUser._id,
        username: newUser.username,
        role: newUser.role,
        ticketBalance: newUser.ticketBalance || 0,
      });

      res.status(201).send('User created successfully');
    } catch (error) {
      console.error('Error creating user:', error.message);
      res.status(500).send(`Error creating user: ${error.message}`);
    }
  }

  // Method to add a new user (public route)
  async addUser(req, res) {
    try {
      const { username, password } = req.body;

      // Check if username already exists
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).send('Username already exists');
      }

      const newUser = new User({
        username,
        password,
        role: 'user', // Public users are assigned 'user' role by default
      });

      await newUser.save();
      res.status(201).send('User registered successfully');
    } catch (error) {
      console.error('Error registering user:', error.message);
      res.status(500).send(`Error registering user: ${error.message}`);
    }
  }

  // Method to get public list of users excluding admins
  async getPublicUsers(req, res) {
    try {
      const users = await User.find({ role: { $ne: 'admin' } }).select('username ticketBalance');
      res.json(users);
    } catch (error) {
      console.error('Error fetching users:', error.message);
      res.status(500).send(`Error fetching users: ${error.message}`);
    }
  }

  // Method to add tickets to a user
  async addTickets(req, res) {
    try {
      const { userId, quantity, reason } = req.body;
      const qty = parseInt(quantity, 10);
  
      const user = await User.findById(userId);
  
      if (!user) {
        return res.status(404).send('User not found');
      }
  
      await user.addTickets(qty, reason);
  
      // Emit socket event for ticket update
      req.app.get('io').emit('ticketUpdate', {
        userId: user._id.toString(),
        ticketBalance: user.ticketBalance,
      });
  
      res.status(200).send('Tickets added successfully');
    } catch (error) {
      console.error('Error adding tickets:', error);
      res.status(500).send(`Error adding tickets: ${error.message}`);
    }
  }

  // Method to remove tickets from a user
  async removeTickets(req, res) {
    try {
      const { userId, quantity, reason } = req.body;
      const qty = parseInt(quantity, 10);
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).send('User not found');
      }

      if (user.ticketBalance < qty) {
        return res.status(400).send('Insufficient tickets');
      }

      await user.removeTickets(qty, reason);

      // Emit socket event for ticket update
      req.app.get('io').emit('ticketUpdate', {
        userId: user._id.toString(),
        ticketBalance: user.ticketBalance,
      });

      res.status(200).send('Tickets removed successfully');
    } catch (error) {
      console.error('Error removing tickets:', error);
      res.status(500).send(`Error removing tickets: ${error.message}`);
    }
  }

  // Method to get a user's transactions
  async getUserTransactions(req, res) {
    try {
      const { userId } = req.params;

      // Find the user and select only the transactions
      const user = await User.findById(userId).select('transactions');
      if (!user) {
        return res.status(404).send('User not found');
      }

      res.json(user.transactions);
    } catch (error) {
      console.error('Error fetching transactions:', error.message);
      res.status(500).send(`Error fetching transactions: ${error.message}`);
    }
  }

  // Method to delete a user
  async deleteUser(req, res) {
    try {
      const { userId } = req.params;

      // Ensure admin cannot delete themselves
      if (req.user._id.toString() === userId) {
        return res.status(400).send("You cannot delete your own account");
      }

      // Find the user to be deleted
      const user = await User.findById(userId);

      if (!user) {
        return res.status(404).send('User not found');
      }

      // Prevent deletion of admin users
      if (user.role === 'admin') {
        return res.status(403).send('Cannot delete an admin user');
      }

      // Delete the user
      await user.deleteOne();

      // Emit a socket event to update user lists
      req.app.get('io').emit('userDeleted', {
        userId: user._id.toString(),
      });

      res.status(200).send('User deleted successfully');
    } catch (error) {
      console.error('Error deleting user:', error.message);
      res.status(500).send(`Error deleting user: ${error.message}`);
    }
  }

  // Method to reset a user's password
  async resetPassword(req, res) {
    try {
      const { userId, newPassword } = req.body;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).send('Password must be at least 6 characters long');
      }

      const user = await User.findById(userId);

      if (!user) {
        return res.status(404).send('User not found');
      }

      // Update password (pre-save hook will hash it)
      user.password = newPassword;
      await user.save();

      res.status(200).send('Password reset successfully');
    } catch (error) {
      console.error('Error resetting password:', error.message);
      res.status(500).send(`Error resetting password: ${error.message}`);
    }
  }

  // Existing methods...
}

module.exports = new UserController();
