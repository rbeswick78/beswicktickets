const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const wallet = require('../services/srmWallet');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  ticketBalance: { type: Number, default: 0 },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  // LEGACY (Phase 2.3): the wallet ledger now lives in the Transaction collection. This field is
  // retained read-only so historical data survives until scripts/migrateTransactions.js has
  // backfilled it and the new collection is verified; nothing writes to it anymore.
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

// Append a ledger entry to the Transaction collection. ticketBalance on the User doc is the
// source of truth for money; this is the audit trail. In a transaction (session passed) the
// insert is part of that transaction so it commits/rolls back atomically with the balance move.
// Outside one — and when there is no live connection (unit tests) — recording is best-effort:
// the balance has already changed, so a failed/absent ledger write must never reverse it.
async function recordTransaction({ userId, type, amount, balance, reason, status = 'approved', session = null }) {
  if (!session && mongoose.connection.readyState !== 1) return;
  const Transaction = require('./Transaction');
  const doc = { userId, type, amount, balance, status, reason };
  if (session) {
    await Transaction.create([doc], { session });
  } else {
    try {
      await Transaction.create(doc);
    } catch (err) {
      console.error('Failed to record transaction (balance already updated):', err);
    }
  }
}

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

// Atomic wallet mutations (Phase 2.1). These replace the old read-modify-write + full-document
// save(), which lost concurrent updates (two operations reading the same balance then each
// writing back) and could clobber a user playing in two games at once. The logic lives in the
// dependency-free services/srmWallet so it is unit-testable without mongoose; here we just bind
// in the model (`this`) and the Transaction recorder.
userSchema.statics.creditTickets = function (userId, quantity, reason, opts) {
  return wallet.creditTickets({ UserModel: this, recordTransaction }, userId, quantity, reason, opts);
};

userSchema.statics.debitTickets = function (userId, quantity, reason, opts) {
  return wallet.debitTickets({ UserModel: this, recordTransaction }, userId, quantity, reason, opts);
};

// Backward-compatible instance wrappers over the atomic statics, for the admin/redeem/payout
// callers that load a user doc and then read `user.ticketBalance` after the move. They keep the
// loaded doc's balance in sync and preserve the old throw-on-failure contract.
userSchema.methods.addTickets = async function (quantity, reason) {
  const updated = await this.constructor.creditTickets(this._id, quantity, reason);
  this.ticketBalance = updated.ticketBalance;
  return this;
};

userSchema.methods.removeTickets = async function (quantity, reason) {
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    throw new Error('Invalid ticket quantity');
  }
  // Sufficiency is decided solely by the atomic debit guard (debitTickets returns null when
  // funds are insufficient). We deliberately do NOT pre-check this.ticketBalance: that in-memory
  // value can be stale (e.g. a concurrent payout credited the user after the doc was loaded), and
  // a stale read would spuriously reject a removal the authoritative guard would allow.
  const updated = await this.constructor.debitTickets(this._id, qty, reason);
  if (!updated) {
    throw new Error('Insufficient tickets');
  }
  this.ticketBalance = updated.ticketBalance;
  return this;
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