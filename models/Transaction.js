const mongoose = require('mongoose');

// Per-event wallet ledger, moved off the User document (Phase 2.3). Previously every credit/
// debit pushed onto an unbounded `transactions` array embedded in the hot User doc, which both
// grew the doc read on every bet and risked the 16 MB document ceiling. Each money movement is
// now one insert here, keyed by userId. `balance` is the user's resulting ticketBalance after
// the event (audit trail); `ticketBalance` on User remains the single source of truth.
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['add', 'spend'], required: true },
  amount: { type: Number, required: true },
  balance: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'approved' },
  reason: { type: String },
  createdAt: { type: Date, default: Date.now },
  // Set by scripts/migrateTransactions.js to the embedded subdoc _id it was copied from. The
  // UNIQUE sparse index is the DB-level backstop that makes the backfill idempotent even under a
  // re-run or two overlapping runs: a duplicate insert is rejected (E11000) rather than relying
  // solely on the script's read-then-insert check. Sparse so live (non-migrated) events, which
  // have no migratedFrom, are exempt.
  migratedFrom: { type: mongoose.Schema.Types.ObjectId, unique: true, sparse: true },
});

// History reads are "this user's events, newest first".
transactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
