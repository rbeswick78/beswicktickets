const mongoose = require('mongoose');
const User = require('../models/User'); // Mongoose model for User
const dbConfigPath = '../config/db'; // Path to your db connection file

async function resetPassword() {
  // Get arguments from command line
  const username = process.argv[2];
  const newPassword = process.argv[3];

  if (!username || !newPassword) {
    console.log('Usage: node scripts/resetPassword.js <username> <new_password>');
    process.exit(1);
  }

  console.log(`--- Password Reset Tool ---`);
  console.log(`Target User: ${username}`);

  // 1. Connect to Database
  try {
    // This typically establishes the connection
    require(dbConfigPath);
    
    // Wait for connection to be ready
    if (mongoose.connection.readyState === 0) {
      console.log('Waiting for DB connection...');
      await new Promise(resolve => mongoose.connection.once('open', resolve));
    }
  } catch (err) {
    console.error('Could not connect to database:', err);
    process.exit(1);
  }

  console.log('Connected to Database.');

  // 2. Find and Update User
  try {
    const user = await User.findOne({ username });

    if (!user) {
      console.error(`[ERROR] User "${username}" not found.`);
      process.exit(1);
    }

    // 3. Update Password
    // The User model likely has a pre-save hook to hash the password
    // So we just set it in plain text and save.
    user.password = newPassword;
    await user.save();

    console.log(`[SUCCESS] Password for "${username}" has been reset.`);
    
  } catch (err) {
    console.error('Error updating password:', err);
  } finally {
    mongoose.connection.close();
    process.exit(0);
  }
}

resetPassword();


