'use strict';

// Atomic wallet primitives (Phase 2.1). Dependency-free (no mongoose) so they can be unit-tested
// with an in-memory model exactly like the rest of the SRM money path. models/User.js wires in
// the real User model (as `UserModel`) and the Transaction recorder; callers reach these through
// the User statics (User.creditTickets / User.debitTickets).
//
// Both use a single guarded findOneAndUpdate with $inc, so the read and the write are one atomic
// database operation — concurrent credits/debits compose correctly with no lost updates and no
// per-user locks. `opts.session` threads a transaction through when one is available.

// Credit: unconditional $inc up. Returns the updated document. Throws only on a bad quantity or
// a missing user (genuine errors), never on a business condition.
async function creditTickets({ UserModel, recordTransaction }, userId, quantity, reason, opts = {}) {
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    throw new Error('Invalid ticket quantity');
  }
  const { session = null } = opts;
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId },
    { $inc: { ticketBalance: qty } },
    { new: true, session }
  );
  if (!updated) {
    throw new Error('User not found');
  }
  await recordTransaction({ userId, type: 'add', amount: qty, balance: updated.ticketBalance, reason, session });
  return updated;
}

// Debit: guarded $inc down. The filter requires ticketBalance >= qty, so the decrement and the
// sufficiency check are one atomic operation (no TOCTOU). Returns the updated document, or `null`
// when funds are insufficient (or the user is missing) — callers treat null as "did not happen".
async function debitTickets({ UserModel, recordTransaction }, userId, quantity, reason, opts = {}) {
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    throw new Error('Invalid ticket quantity');
  }
  const { session = null } = opts;
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId, ticketBalance: { $gte: qty } },
    { $inc: { ticketBalance: -qty } },
    { new: true, session }
  );
  if (!updated) {
    return null; // insufficient funds (or user not found)
  }
  await recordTransaction({ userId, type: 'spend', amount: qty, balance: updated.ticketBalance, reason, session });
  return updated;
}

module.exports = { creditTickets, debitTickets };
