// End-to-end checks against a REAL MongoDB. Skipped unless MONGODB_URI is set, so they never run
// (or connect) in the default `npm test` here. The Phase 1 check and the wallet-convergence
// check work on a plain standalone mongod (findOneAndUpdate / $inc only); the transaction
// rollback check additionally needs a replica set and skips itself otherwise. Run with, e.g.:
//   MONGODB_URI=mongodb://localhost:27017/srm_test npm test
const test = require('node:test');
const assert = require('node:assert');

const SKIP = process.env.MONGODB_URI ? false : 'set MONGODB_URI to run the DB integration test';

test('integration: bet-before-deal is recorded+charged against a real DB', { skip: SKIP }, async () => {
  const mongoose = require('mongoose');
  const SrmGame = require('../models/SrmGame');
  const User = require('../models/User');
  const { createSerializer, handlePlayerBetBatch, handleDealCards } = require('../services/srmGameHandlers');
  const { getShuffledDeckOf54 } = require('../utils/deck');

  await mongoose.connect(process.env.MONGODB_URI);

  let user;
  let game;
  try {
    const stamp = String(Date.now());
    user = await User.create({ username: `srm_test_${stamp}`, password: 'test-pw', ticketBalance: 100 });
    game = await SrmGame.create({
      code: `T${stamp}`.slice(-12),
      dealer: user._id,
      players: [user._id],
      roundStatus: 'betting',
      // Seed a pre-existing bet keyed by a real ObjectId so the bet-merge path
      // (b.userId.toString() === userId) is exercised end-to-end against the DB.
      bets: [{ userId: user._id, spotId: 'card1-high', amount: 5 }],
    });

    const { runSerialized } = createSerializer();
    const io = { to: () => ({ emit() {} }), emit() {} };
    const socket = { emit() {} };
    const deps = {
      SrmGame,
      User,
      io,
      runSerialized,
      computePayouts: async () => {}, // isolate the serialization/atomicity behaviour
      getShuffledDeckOf54,
      getOrAssignColor: () => '#fff',
    };

    const gameId = game._id.toString();
    const userId = user._id.toString();

    const pBet = handlePlayerBetBatch(deps, socket, { gameId, userId, bets: [{ spotId: 'card1-high', amount: 10 }] });
    const pDeal = handleDealCards(deps, socket, { gameId, userId });
    await Promise.all([pBet, pDeal]);

    const freshUser = await User.findById(user._id);
    const freshGame = await SrmGame.findById(game._id);
    assert.strictEqual(freshUser.ticketBalance, 90, 'charged exactly the +10 delta');
    const high = freshGame.bets.filter((b) => b.spotId === 'card1-high');
    assert.strictEqual(high.length, 1, 'merged into the existing bet, not duplicated');
    assert.strictEqual(high[0].amount, 15, '5 seeded + 10 added (ObjectId merge worked)');
    assert.strictEqual(freshGame.roundStatus, 'results', 'round advanced to results');
  } finally {
    if (game) await SrmGame.deleteOne({ _id: game._id });
    if (user) await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  }
});

test('integration: a concurrent credit and debit on one user converge (atomic $inc)', { skip: SKIP }, async () => {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Transaction = require('../models/Transaction');

  await mongoose.connect(process.env.MONGODB_URI);

  let user;
  try {
    const stamp = String(Date.now());
    user = await User.create({ username: `srm_wallet_${stamp}`, password: 'test-pw', ticketBalance: 100 });
    const uid = user._id.toString();

    // Race a credit (+50) and a debit (-30) on the same user. Atomic $inc => 120, never a lost update.
    await Promise.all([
      User.creditTickets(uid, 50, 'concurrent credit'),
      User.debitTickets(uid, 30, 'concurrent debit'),
    ]);

    const fresh = await User.findById(uid);
    assert.strictEqual(fresh.ticketBalance, 120, '100 + 50 - 30, both moves applied');

    // Each move is logged once in the Transaction collection.
    const txns = await Transaction.find({ userId: uid });
    assert.strictEqual(txns.length, 2, 'one ledger row per move');

    await Transaction.deleteMany({ userId: uid });
  } finally {
    if (user) await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  }
});

test('integration: addTickets/removeTickets wrappers stay atomic, sync the doc, and throw on insufficient', { skip: SKIP }, async () => {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Transaction = require('../models/Transaction');

  await mongoose.connect(process.env.MONGODB_URI);

  let user;
  try {
    const stamp = String(Date.now());
    user = await User.create({ username: `srm_wrap_${stamp}`, password: 'test-pw', ticketBalance: 20 });

    await user.addTickets(30, 'wrapper add');
    assert.strictEqual(user.ticketBalance, 50, 'addTickets syncs the loaded doc balance');
    assert.strictEqual((await User.findById(user._id)).ticketBalance, 50, 'and persists it');

    await user.removeTickets(15, 'wrapper remove');
    assert.strictEqual(user.ticketBalance, 35, 'removeTickets syncs the loaded doc balance');

    // Insufficient: must throw and NOT change the balance (the atomic guard is authoritative).
    await assert.rejects(() => user.removeTickets(9999, 'too much'), /Insufficient tickets/);
    assert.strictEqual((await User.findById(user._id)).ticketBalance, 35, 'no debit on insufficient');

    await Transaction.deleteMany({ userId: user._id });
  } finally {
    if (user) await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  }
});

test('integration: a transaction abort rolls back the debit (replica set only)', { skip: SKIP }, async (t) => {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Transaction = require('../models/Transaction');
  const { detectTransactionSupport, buildWithTransaction } = require('../services/mongoTransactions');

  await mongoose.connect(process.env.MONGODB_URI);

  let user;
  try {
    if (!(await detectTransactionSupport(mongoose.connection, Transaction))) {
      t.skip('deployment has no transaction support (not a replica set)');
      return;
    }

    const stamp = String(Date.now());
    user = await User.create({ username: `srm_txn_${stamp}`, password: 'test-pw', ticketBalance: 100 });
    const uid = user._id.toString();
    const withTransaction = buildWithTransaction(mongoose.connection);

    // Debit inside a transaction, then throw: the abort must undo both the balance change and the
    // ledger insert.
    await assert.rejects(
      withTransaction(async (session) => {
        const debited = await User.debitTickets(uid, 40, 'doomed debit', { session });
        assert.ok(debited, 'debit applied inside the transaction');
        throw new Error('force abort');
      }),
      /force abort/
    );

    const fresh = await User.findById(uid);
    assert.strictEqual(fresh.ticketBalance, 100, 'debit rolled back on abort');
    const txns = await Transaction.find({ userId: uid });
    assert.strictEqual(txns.length, 0, 'ledger insert rolled back on abort');
  } finally {
    if (user) await User.deleteOne({ _id: user._id });
    await mongoose.disconnect();
  }
});
