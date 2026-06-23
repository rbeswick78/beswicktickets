// Concurrency & atomicity regression tests for Phase 1 (serialized deal/clear + guarded
// transitions + validated bet commit). No live MongoDB: faithful in-memory fakes model the
// two model methods the handlers rely on — findById (returns a snapshot) and findOneAndUpdate
// (atomic, precondition-guarded). A gated end-to-end variant against a real DB lives in
// srmGameHandlers.integration.test.js.
const test = require('node:test');
const assert = require('node:assert');
const {
  createSerializer,
  handlePlayerBetBatch,
  handleDealCards,
  handleClearRound,
} = require('../services/srmGameHandlers');
const { MAX_ROUND_STAKE } = require('../services/srmBetValidation');

const DECK3 = [
  { rank: '2', suit: '♣', display: '2♣', isJoker: false },
  { rank: '5', suit: '♦', display: '5♦', isJoker: false },
  { rank: '9', suit: '♥', display: '9♥', isJoker: false },
];

// Clone a game snapshot the way mongoose hands one back, but PRESERVE each bet's userId by
// reference. In production game.bets[].userId is an ObjectId (not a string), so the handler's
// `b.userId.toString() === userId` comparisons are load-bearing — a JSON clone would flatten an
// ObjectId-like value to a primitive string and hide a dropped `.toString()`. Tests seed userId
// as an object via oid() to exercise that exact coercion.
const cloneBets = (bets) => bets.map((b) => ({ userId: b.userId, spotId: b.spotId, amount: b.amount }));
const cloneCards = (cards) => cards.map((c) => ({ ...c }));
function cloneGame(g) {
  return {
    _id: g._id,
    code: g.code,
    dealer: g.dealer,
    players: [...g.players],
    roundStatus: g.roundStatus,
    bets: cloneBets(g.bets),
    dealtCards: cloneCards(g.dealtCards),
  };
}

// An ObjectId-like stand-in: NOT === its string form, but .toString() yields it (like mongoose).
const oid = (s) => ({ toString: () => s });

// Mimic MongoDB filter matching for the filters the handlers actually use.
function matchesFilter(doc, filter) {
  for (const [key, want] of Object.entries(filter)) {
    const got = doc[key];
    if (want && typeof want === 'object' && Array.isArray(want.$in)) {
      if (!want.$in.includes(got)) return false;
    } else if (got !== want) {
      return false;
    }
  }
  return true;
}

// In-memory SrmGame: findById returns a snapshot; findOneAndUpdate applies $set atomically
// only if the precondition filter still matches the *current* stored doc (else returns null).
function makeGameModel(store) {
  return {
    async findById(id) {
      return store[id] ? cloneGame(store[id]) : null;
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      const doc = store[filter._id];
      if (!doc || !matchesFilter(doc, filter)) return null;
      if (update.$set) {
        // Assign per-key (no JSON flattening) so an ObjectId-like userId survives the write.
        for (const [key, value] of Object.entries(update.$set)) doc[key] = value;
      }
      return opts.new ? cloneGame(doc) : null;
    },
  };
}

function makeUser({ _id, username, ticketBalance, onDebit }) {
  return {
    _id,
    username,
    ticketBalance,
    onDebit, // read via `this` so tests can attach the hook after setup()
    async removeTickets(qty) {
      this.ticketBalance -= qty;
      if (this.onDebit) await this.onDebit();
    },
    async addTickets(qty) {
      this.ticketBalance += qty;
    },
  };
}

function makeUserModel(usersById) {
  return { async findById(id) { return usersById[id] || null; } };
}

function makeIo() {
  const emitted = [];
  const io = {
    to() { return { emit(event, payload) { emitted.push({ event, payload }); } }; },
    emit(event, payload) { emitted.push({ event, payload }); },
  };
  io.emitted = emitted;
  return io;
}

const makeSocket = () => ({ emitted: [], emit(event, payload) { this.emitted.push({ event, payload }); } });
const had = (sink, event) => sink.filter((e) => e.event === event);

function setup({ roundStatus = 'betting', bets = [], balance = 50, onDebit = null } = {}) {
  const gameId = 'g1';
  const userId = 'u1';
  const dealerId = 'dealer1';
  const store = {
    [gameId]: {
      _id: gameId,
      code: 7,
      dealer: dealerId,
      players: [userId],
      roundStatus,
      bets: cloneBets(bets),
      dealtCards: [],
    },
  };
  const user = makeUser({ _id: userId, username: 'Alice', ticketBalance: balance, onDebit });
  const usersById = { [userId]: user };
  let payoutCalls = 0;
  const io = makeIo();
  const { runSerialized } = createSerializer();
  const deps = {
    SrmGame: makeGameModel(store),
    User: makeUserModel(usersById),
    io,
    runSerialized,
    computePayouts: async () => { payoutCalls += 1; },
    getShuffledDeckOf54: () => cloneCards(DECK3),
    getOrAssignColor: () => '#abcdef',
  };
  return { gameId, userId, dealerId, store, user, io, deps, payouts: () => payoutCalls };
}

// ---- The core invariant: a bet resolving across a deal is all-or-nothing ----

test('charged-and-dropped is impossible: a deal landing between a bet read and its commit reverses the charge', async () => {
  const ctx = setup({ balance: 50 });
  const socket = makeSocket();
  // Simulate a concurrent deal landing immediately after the wallet debit, before the
  // guarded game.bets commit. The guard must then reject and the charge must be reversed.
  ctx.user.onDebit = async () => { ctx.store[ctx.gameId].roundStatus = 'resultsPending'; };

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId,
    userId: ctx.userId,
    bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 50, 'the charge must be fully reversed');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'no bet may be recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1, 'player is told the bet did not land');
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 0, 'no confirmation may be broadcast');
});

test('bet enqueued before a deal is fully recorded and charged', async () => {
  const ctx = setup({ balance: 50 });
  const betSocket = makeSocket();
  const dealerSocket = makeSocket();

  const pBet = handlePlayerBetBatch(ctx.deps, betSocket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });
  const pDeal = handleDealCards(ctx.deps, dealerSocket, { gameId: ctx.gameId, userId: ctx.dealerId });
  await Promise.all([pBet, pDeal]);

  assert.strictEqual(ctx.user.ticketBalance, 40, 'charged exactly the stake');
  const recorded = ctx.store[ctx.gameId].bets.find((b) => b.userId === ctx.userId && b.spotId === 'card1-high');
  assert.ok(recorded && recorded.amount === 10, 'bet fully recorded');
  assert.strictEqual(had(betSocket.emitted, 'betError').length, 0);
  assert.strictEqual(had(ctx.io.emitted, 'cardsDealt').length, 1, 'the deal still proceeds afterwards');
});

test('bet enqueued after a deal is rejected and not charged', async () => {
  const ctx = setup({ balance: 50 });
  const betSocket = makeSocket();
  const dealerSocket = makeSocket();

  const pDeal = handleDealCards(ctx.deps, dealerSocket, { gameId: ctx.gameId, userId: ctx.dealerId });
  const pBet = handlePlayerBetBatch(ctx.deps, betSocket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });
  await Promise.all([pDeal, pBet]);

  assert.strictEqual(ctx.user.ticketBalance, 50, 'not charged');
  assert.ok(!ctx.store[ctx.gameId].bets.some((b) => b.userId === ctx.userId), 'not recorded');
  assert.strictEqual(had(betSocket.emitted, 'betError').length, 1);
});

// ---- Guarded transitions ----

test('a second concurrent deal is rejected — no double-deal, no double payout', async () => {
  const ctx = setup();
  const s1 = makeSocket();
  const s2 = makeSocket();

  const p1 = handleDealCards(ctx.deps, s1, { gameId: ctx.gameId, userId: ctx.dealerId });
  const p2 = handleDealCards(ctx.deps, s2, { gameId: ctx.gameId, userId: ctx.dealerId });
  await Promise.all([p1, p2]);

  assert.strictEqual(ctx.payouts(), 1, 'payouts computed exactly once');
  assert.strictEqual(had(ctx.io.emitted, 'cardsDealt').length, 1, 'cards dealt exactly once');
  assert.strictEqual(had(s2.emitted, 'betError').length, 1, 'the loser deal is told cards were already dealt');
  assert.strictEqual(ctx.store[ctx.gameId].roundStatus, 'results');
});

test('only the dealer can deal', async () => {
  const ctx = setup();
  const socket = makeSocket();
  await handleDealCards(ctx.deps, socket, { gameId: ctx.gameId, userId: 'not-the-dealer' });
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
  assert.strictEqual(ctx.payouts(), 0);
  assert.strictEqual(ctx.store[ctx.gameId].roundStatus, 'betting');
});

test('clearRound during betting is rejected', async () => {
  const ctx = setup({ roundStatus: 'betting', bets: [{ userId: 'u1', spotId: 'card1-high', amount: 5 }] });
  const socket = makeSocket();
  await handleClearRound(ctx.deps, socket, { gameId: ctx.gameId, userId: ctx.dealerId });
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
  assert.strictEqual(had(ctx.io.emitted, 'roundCleared').length, 0);
  assert.strictEqual(ctx.store[ctx.gameId].roundStatus, 'betting', 'betting state untouched');
  assert.strictEqual(ctx.store[ctx.gameId].bets.length, 1, 'bets untouched');
});

test('clearRound from results resets the round', async () => {
  const ctx = setup({ roundStatus: 'results', bets: [{ userId: 'u1', spotId: 'card1-high', amount: 5 }] });
  const socket = makeSocket();
  await handleClearRound(ctx.deps, socket, { gameId: ctx.gameId, userId: ctx.dealerId });
  assert.strictEqual(had(ctx.io.emitted, 'roundCleared').length, 1);
  assert.strictEqual(ctx.store[ctx.gameId].roundStatus, 'betting');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, []);
  assert.deepStrictEqual(ctx.store[ctx.gameId].dealtCards, []);
});

// ---- Validation & normalization at the trust boundary ----

test('handler rejects a fractional bet without charging or recording', async () => {
  const ctx = setup({ balance: 50 });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 1.9 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 50, 'not charged');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'not recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('handler rejects an unknown spotId without charging', async () => {
  const ctx = setup({ balance: 50 });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card9-moon', amount: 5 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 50);
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, []);
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('handler enforces the per-user per-round stake cap', async () => {
  const ctx = setup({
    balance: 10,
    bets: [{ userId: 'u1', spotId: 'card1-high', amount: MAX_ROUND_STAKE }],
  });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-low', amount: 1 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 10, 'not charged when over the cap');
  assert.ok(!ctx.store[ctx.gameId].bets.some((b) => b.spotId === 'card1-low'), 'over-cap bet not recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('insufficient balance is rejected before recording', async () => {
  const ctx = setup({ balance: 3 });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 3, 'not charged');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, []);
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('happy path: a valid bet is charged, recorded, and broadcast', async () => {
  const ctx = setup({ balance: 50 });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId,
    bets: [{ spotId: 'card1-high', amount: 10 }, { spotId: 'card2-joker', amount: 5 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 35, 'charged the total stake');
  const bets = ctx.store[ctx.gameId].bets;
  assert.strictEqual(bets.find((b) => b.spotId === 'card1-high').amount, 10);
  assert.strictEqual(bets.find((b) => b.spotId === 'card2-joker').amount, 5);
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 1);
  assert.strictEqual(had(ctx.io.emitted, 'ticketUpdate').length, 1);
  assert.strictEqual(had(socket.emitted, 'betError').length, 0);
});

test('an addition merges into an ObjectId-keyed existing bet (not duplicated) and is charged the delta', async () => {
  // game.bets[].userId is an ObjectId in production; seed an ObjectId-like value so the
  // handler's `b.userId.toString() === userId` merge path is genuinely exercised.
  const ctx = setup({ balance: 100, bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: 5 }] });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId,
    bets: [{ spotId: 'card1-high', amount: 7 }, { spotId: 'card2-joker', amount: 3 }],
  });
  const bets = ctx.store[ctx.gameId].bets;
  const high = bets.filter((b) => b.spotId === 'card1-high');
  assert.strictEqual(high.length, 1, 'must merge into the existing bet, not duplicate it');
  assert.strictEqual(high[0].amount, 12, '5 existing + 7 added');
  assert.strictEqual(bets.find((b) => b.spotId === 'card2-joker').amount, 3);
  assert.strictEqual(ctx.user.ticketBalance, 90, 'charged only the +10 delta');
  assert.strictEqual(had(socket.emitted, 'betError').length, 0);
});

test('the stake cap counts an ObjectId-keyed existing stake', async () => {
  const ctx = setup({ balance: 10, bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: MAX_ROUND_STAKE }] });
  const socket = makeSocket();
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-low', amount: 1 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 10, 'rejected — the ObjectId-keyed existing stake counts toward the cap');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('a net-zero rearrangement commits the new bets without any wallet change', async () => {
  const ctx = setup({ balance: 50, bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: 5 }] });
  const socket = makeSocket();
  // +5 on a fresh spot, -5 clamped on the existing spot => netAmount === 0, but bets still change.
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId,
    bets: [{ spotId: 'card1-low', amount: 5 }, { spotId: 'card1-high', amount: -5 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 50, 'no wallet movement for a net-zero batch');
  const bets = ctx.store[ctx.gameId].bets;
  assert.ok(!bets.some((b) => b.spotId === 'card1-high'), 'the zeroed spot is removed');
  assert.strictEqual(bets.find((b) => b.spotId === 'card1-low').amount, 5, 'the new spot is recorded');
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 1, 'the change is still broadcast');
  assert.strictEqual(had(socket.emitted, 'betError').length, 0);
});

test('bet-then-clear from results: the late bet is rejected (not charged), then the round clears', async () => {
  const ctx = setup({ roundStatus: 'results', bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: 5 }], balance: 50 });
  const betSocket = makeSocket();
  const dealerSocket = makeSocket();

  const pBet = handlePlayerBetBatch(ctx.deps, betSocket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-low', amount: 10 }],
  });
  const pClear = handleClearRound(ctx.deps, dealerSocket, { gameId: ctx.gameId, userId: ctx.dealerId });
  await Promise.all([pBet, pClear]);

  assert.strictEqual(ctx.user.ticketBalance, 50, 'late bet not charged (round not in betting)');
  assert.strictEqual(had(betSocket.emitted, 'betError').length, 1);
  assert.strictEqual(ctx.store[ctx.gameId].roundStatus, 'betting');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'round cleared');
});

test('clear-then-bet from results: clear resets first, then the new bet lands cleanly (no resurrected bets)', async () => {
  const ctx = setup({ roundStatus: 'results', bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: 5 }], balance: 50 });
  const betSocket = makeSocket();
  const dealerSocket = makeSocket();

  const pClear = handleClearRound(ctx.deps, dealerSocket, { gameId: ctx.gameId, userId: ctx.dealerId });
  const pBet = handlePlayerBetBatch(ctx.deps, betSocket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-low', amount: 10 }],
  });
  await Promise.all([pClear, pBet]);

  assert.strictEqual(ctx.user.ticketBalance, 40, 'charged the new bet only');
  const bets = ctx.store[ctx.gameId].bets;
  assert.ok(!bets.some((b) => b.spotId === 'card1-high'), 'previous-round bets are NOT resurrected');
  assert.strictEqual(bets.find((b) => b.spotId === 'card1-low').amount, 10);
  assert.strictEqual(had(betSocket.emitted, 'betError').length, 0);
});

test('a duplicate-spot refund batch cannot over-refund (no minting)', async () => {
  const ctx = setup({ balance: 40, bets: [{ userId: 'u1', spotId: 'card1-high', amount: 10 }] });
  const socket = makeSocket();
  // Malicious client: two refund entries for the same spot, each clamped to the 10 stake.
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId,
    bets: [{ spotId: 'card1-high', amount: -10 }, { spotId: 'card1-high', amount: -10 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 40, 'no tickets minted — batch rejected, nothing refunded');
  assert.strictEqual(ctx.store[ctx.gameId].bets.find((b) => b.spotId === 'card1-high').amount, 10, 'stake untouched');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('a removal refunds and is clamped to the existing stake', async () => {
  const ctx = setup({ balance: 40, bets: [{ userId: 'u1', spotId: 'card1-high', amount: 10 }] });
  const socket = makeSocket();
  // Try to remove 999 from a 10 stake — refund must clamp to 10, leaving the spot at 0 (dropped).
  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: -999 }],
  });
  assert.strictEqual(ctx.user.ticketBalance, 50, 'refund clamped to the 10 actually wagered');
  assert.ok(!ctx.store[ctx.gameId].bets.some((b) => b.spotId === 'card1-high'), 'zeroed bet removed');
});
