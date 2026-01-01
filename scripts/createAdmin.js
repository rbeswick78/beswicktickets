const mongoose = require('mongoose');
require('../config/db'); // Establishes the connection
const User = require('../models/User');

async function createAdmin() {
  try {
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      console.log('Admin user already exists.');
      mongoose.connection.close();
      return;
    }

    const adminUser = new User({
      username: 'admin',
      password: 'admin123', // Use a strong password
      role: 'admin',
    });

    await adminUser.save();
    console.log('Admin user created successfully.');
    mongoose.connection.close();
  } catch (err) {
    console.error('Error creating admin user:', err);
    mongoose.connection.close();
  }
}

createAdmin();