const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  ticketBalance: { type: Number, default: 0 },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  transactions: [
    {
      type: { type: String, enum: ['add', 'spend'], required: true },
      amount: { type: Number, required: true },
      balance: { type: Number, required: true },
      status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' },
      reason: { type: String },
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.addTickets = async function (quantity, reason) {
  const qty = parseInt(quantity, 10);

  if (isNaN(qty) || qty <= 0) {
    throw new Error('Invalid ticket quantity');
  }

  this.ticketBalance += qty;

  this.transactions.push({
    type: 'add',
    amount: qty,
    balance: this.ticketBalance,
    status: 'approved',
    reason: reason,
  });

  try {
    await this.save();
  } catch (err) {
    console.error('Error saving user after adding tickets:', err);
    throw err; // Re-throw the error to be caught in the controller
  }
};

// Method to remove tickets
userSchema.methods.removeTickets = async function (quantity, reason) {
  const qty = parseInt(quantity, 10);

  if (isNaN(qty) || qty <= 0) {
    throw new Error('Invalid ticket quantity');
  }

  if (this.ticketBalance < qty) {
    throw new Error('Insufficient tickets');
  }

  this.ticketBalance -= qty;

  this.transactions.push({
    type: 'spend',
    amount: qty,
    balance: this.ticketBalance,
    status: 'approved',
    reason: reason,
  });

  try {
    await this.save();
  } catch (err) {
    console.error('Error saving user after removing tickets:', err);
    throw err; // Re-throw the error to be caught in the controller
  }
};

// Pre-remove middleware
userSchema.pre('remove', function (next) {
  if (this.role === 'admin') {
    const err = new Error('Cannot delete an admin user');
    next(err);
  } else {
    next();
  }
});

const User = mongoose.model('User', userSchema);
module.exports = User;