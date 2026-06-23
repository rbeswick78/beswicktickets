// End-to-end Phase 1 check against a REAL MongoDB. Skipped unless MONGODB_URI is set, so it
// never runs (or connects) in the default `npm test` here. Works on a plain standalone mongod
// (Phase 1 uses only findOneAndUpdate, not transactions). Run with, e.g.:
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
