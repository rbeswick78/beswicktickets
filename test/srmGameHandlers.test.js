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

// In-memory SrmGame: findById returns a snapshot; findOneAndUpdate applies $set atomically only
// if the precondition filter still matches the *current* stored doc (else returns null). When a
// session is passed (transaction path), each write records an undo so the session can roll it
// back — modelling MongoDB rolling back only the writes made within the transaction. Test hooks:
//   - failNextFindOneAndUpdate: force the next write to throw (a forced game-write failure)
//   - beforeWrite: one-shot, fires at the start of the next write (race landing before it)
//   - onBetsWrite: one-shot, fires after a successful bets write (race landing right after it)
function makeGameModel(store) {
  const model = {
    failNextFindOneAndUpdate: false,
    beforeWrite: null,
    onBetsWrite: null,
    async findById(id) {
      return store[id] ? cloneGame(store[id]) : null;
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      if (typeof model.beforeWrite === 'function') {
        const hook = model.beforeWrite;
        model.beforeWrite = null;
        await hook();
      }
      if (model.failNextFindOneAndUpdate) {
        model.failNextFindOneAndUpdate = false;
        throw new Error('forced game write failure');
      }
      const doc = store[filter._id];
      if (!doc || !matchesFilter(doc, filter)) return null;
      if (update.$set) {
        // Assign per-key (no JSON flattening) so an ObjectId-like userId survives the write.
        for (const [key, value] of Object.entries(update.$set)) {
          const old = doc[key];
          if (opts.session && opts.session._undo) {
            opts.session._undo.push(() => {
              doc[key] = old;
            });
          }
          doc[key] = value;
        }
      }
      if (update.$set && 'bets' in update.$set && typeof model.onBetsWrite === 'function') {
        const hook = model.onBetsWrite;
        model.onBetsWrite = null;
        await hook();
      }
      return opts.new ? cloneGame(doc) : null;
    },
  };
  return model;
}

function makeUser({ _id, username, ticketBalance, onDebit }) {
  // Plain holder; the wallet moves now happen through the model's atomic statics (Phase 2.1).
  // `onDebit` is fired by debitTickets so a test can inject a concurrent change mid-debit.
  return { _id, username, ticketBalance, onDebit };
}

// In-memory User model with the atomic wallet statics the handler now uses. Each static mutates
// the stored user in one synchronous step (modelling MongoDB's atomic $inc) and, when a session
// is passed, records an undo so the transaction fake can roll it back. debitTickets honors the
// {$gte} guard: it returns null (no change) when funds are insufficient.
function makeUserModel(usersById) {
  return {
    async findById(id) {
      return usersById[id] || null;
    },
    async debitTickets(userId, qty, reason, opts = {}) {
      const user = usersById[userId];
      if (!user || user.ticketBalance < qty) return null;
      const old = user.ticketBalance;
      user.ticketBalance -= qty;
      if (opts.session && opts.session._undo) {
        opts.session._undo.push(() => {
          user.ticketBalance = old;
        });
      }
      if (typeof user.onDebit === 'function') await user.onDebit();
      return { _id: user._id, username: user.username, ticketBalance: user.ticketBalance };
    },
    async creditTickets(userId, qty, reason, opts = {}) {
      const user = usersById[userId];
      if (!user) throw new Error('User not found');
      const old = user.ticketBalance;
      user.ticketBalance += qty;
      if (opts.session && opts.session._undo) {
        opts.session._undo.push(() => {
          user.ticketBalance = old;
        });
      }
      return { _id: user._id, username: user.username, ticketBalance: user.ticketBalance };
    },
  };
}

// Faithful in-memory withTransaction: runs work(session); on success the writes stand, on throw
// every write tagged with this session's undo is rolled back (newest first) and the error is
// rethrown. Writes made WITHOUT the session (a concurrent external change) are not rolled back,
// exactly like a real transaction.
function makeWithTransaction() {
  return async function withTransaction(work) {
    const session = { _undo: [] };
    try {
      return await work(session);
    } catch (err) {
      for (const undo of session._undo.slice().reverse()) undo();
      throw err;
    }
  };
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

// `transactions` selects the commit path under test: true (default) injects a faithful
// withTransaction (the production replica-set path); false leaves it null so the handler takes
// the single-document-atomic fallback.
function setup({ roundStatus = 'betting', bets = [], balance = 50, onDebit = null, transactions = true } = {}) {
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
  const gameModel = makeGameModel(store);
  const userModel = makeUserModel(usersById);
  const deps = {
    SrmGame: gameModel,
    User: userModel,
    io,
    runSerialized,
    withTransaction: transactions ? makeWithTransaction() : null,
    computePayouts: async () => { payoutCalls += 1; },
    getShuffledDeckOf54: () => cloneCards(DECK3),
    getOrAssignColor: () => '#abcdef',
  };
  return { gameId, userId, dealerId, store, user, io, deps, gameModel, userModel, payouts: () => payoutCalls };
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

// ---- Phase 2: wallet integrity (atomic wallet+bet under both commit paths) ----

test('a payout credit racing a bet debit on the same user converges to the correct balance', async () => {
  // The classic lost-update race: a payout credits the same user mid-bet. With atomic $inc both
  // moves apply; a read-modify-write would drop one. The credit fires (without a session — a
  // separate process) right after the debit's balance write, before the bets commit.
  const ctx = setup({ balance: 100 });
  const socket = makeSocket();
  ctx.user.onDebit = async () => {
    await ctx.deps.User.creditTickets(ctx.userId, 50, 'payout');
  };

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 30 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 120, '100 - 30 debit + 50 credit: both moves applied');
  assert.strictEqual(
    ctx.store[ctx.gameId].bets.find((b) => b.spotId === 'card1-high').amount,
    30,
    'the bet is recorded'
  );
  assert.strictEqual(had(socket.emitted, 'betError').length, 0);
});

test('transaction path: a forced game-write failure rolls the wallet back (no drift)', async () => {
  const ctx = setup({ balance: 50 }); // transaction path (default)
  const socket = makeSocket();
  ctx.gameModel.failNextFindOneAndUpdate = true; // the bets write throws inside the transaction

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 50, 'the debit was rolled back with the transaction');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'no bet recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 0, 'nothing confirmed');
});

test('transaction path: a refund (net-negative) rolls back too when the game write fails', async () => {
  const ctx = setup({ balance: 40, bets: [{ userId: oid('u1'), spotId: 'card1-high', amount: 10 }] });
  const socket = makeSocket();
  ctx.gameModel.failNextFindOneAndUpdate = true;

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: -10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 40, 'the refund credit was rolled back, not kept');
  assert.strictEqual(
    ctx.store[ctx.gameId].bets.find((b) => b.spotId === 'card1-high').amount,
    10,
    'the stake is untouched'
  );
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('fallback path: a valid bet is charged, recorded, and broadcast', async () => {
  const ctx = setup({ balance: 50, transactions: false });
  const socket = makeSocket();

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 40, 'charged the stake');
  assert.strictEqual(ctx.store[ctx.gameId].bets.find((b) => b.spotId === 'card1-high').amount, 10);
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 1);
  assert.strictEqual(had(ctx.io.emitted, 'ticketUpdate').length, 1);
  assert.strictEqual(had(socket.emitted, 'betError').length, 0);
});

test('fallback path: a forced bets-write failure leaves the wallet untouched (no drift)', async () => {
  const ctx = setup({ balance: 50, transactions: false });
  const socket = makeSocket();
  ctx.gameModel.failNextFindOneAndUpdate = true; // bets write is first; it throws before any debit

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 50, 'wallet never touched — bets write is first');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'no bet recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
});

test('fallback path: betting closing before the bets write no-ops without touching the wallet', async () => {
  const ctx = setup({ balance: 50, transactions: false });
  const socket = makeSocket();
  // A deal lands between our snapshot read and the bets write: the guard then no-ops it.
  ctx.gameModel.beforeWrite = async () => {
    ctx.store[ctx.gameId].roundStatus = 'resultsPending';
  };

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 50, 'wallet untouched when the bets write no-ops');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'no bet recorded');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
  assert.match(had(socket.emitted, 'betError')[0].payload.message, /betting closed/i, 'reason is betting-closed');
});

test('fallback path: a debit failing after the bets write rolls the bets back (no drift)', async () => {
  const ctx = setup({ balance: 50, transactions: false });
  const socket = makeSocket();
  // A concurrent drain empties the balance right after the (successful) bets write, before our
  // debit. The debit guard then fails, and the bets must be rolled back to the pre-image.
  ctx.gameModel.onBetsWrite = async () => {
    ctx.user.ticketBalance = 0;
  };

  await handlePlayerBetBatch(ctx.deps, socket, {
    gameId: ctx.gameId, userId: ctx.userId, bets: [{ spotId: 'card1-high', amount: 10 }],
  });

  assert.strictEqual(ctx.user.ticketBalance, 0, 'no over-charge — the debit found insufficient funds');
  assert.deepStrictEqual(ctx.store[ctx.gameId].bets, [], 'the bets write was rolled back to the pre-image');
  assert.strictEqual(had(socket.emitted, 'betError').length, 1);
  assert.match(had(socket.emitted, 'betError')[0].payload.message, /insufficient/i, 'reason is insufficient funds');
  assert.strictEqual(had(ctx.io.emitted, 'betPlacedBatch').length, 0, 'nothing confirmed');
});
