'use strict';

// Money/state socket handlers for "Steal Ryan's Money", extracted from app.js so the
// concurrency- and atomicity-critical logic can be exercised by `node --test` without a
// live MongoDB. Collaborators (models, io, payout service, deck, serializer) are injected
// via `deps` so tests can substitute in-memory fakes.
//
// Phase 1 guarantees:
//  1.1 dealCards / clearRound run through the SAME per-game serialization queue as bets,
//      so a deal/clear can no longer interleave with an in-flight bet batch.
//  1.2 Every state transition is a precondition-guarded findOneAndUpdate. A null result
//      means "state changed under us" and the operation no-ops (and reverses any wallet
//      move), instead of resurrecting a dealt round or charging-and-dropping a bet.
//  1.3 Bet batches are validated/normalized at the trust boundary, with ONE integer amount
//      used for both the wallet debit and game.bets, plus a per-user per-round stake cap.

const { validateBetBatch, MAX_ROUND_STAKE } = require('./srmBetValidation');

/**
 * Create an isolated per-game serialization queue. Tasks for the same gameId run strictly
 * one-at-a-time, in enqueue order; a failing task is logged and does not block the queue.
 */
function createSerializer() {
  const gameQueues = {}; // gameId -> Promise chain

  function runSerialized(gameId, task) {
    if (!gameQueues[gameId]) {
      gameQueues[gameId] = Promise.resolve();
    }
    const next = gameQueues[gameId].then(task).catch((err) => {
      console.error(`Serialized task error for game ${gameId}:`, err);
    });
    gameQueues[gameId] = next;
    return next;
  }

  return { runSerialized, gameQueues };
}

/**
 * Batched bet handler. Validates the batch up front (synchronously), then commits inside the
 * per-game queue. The game.bets write is guarded on roundStatus:'betting'; if the round was
 * dealt/cleared under us the wallet move is reversed and nothing is recorded.
 */
function handlePlayerBetBatch(deps, socket, batchData) {
  const { SrmGame, User, io, runSerialized, withTransaction } = deps;
  const { gameId, userId, bets } = batchData || {};

  if (!gameId || !userId) return Promise.resolve();

  // Trust-boundary validation (integer amounts, |amount| <= MAX_BET, allowlisted spotIds).
  const validation = validateBetBatch(bets);
  if (!validation.ok) {
    socket.emit('betError', { message: validation.reason });
    return Promise.resolve();
  }

  return runSerialized(gameId, async () => {
    const game = await SrmGame.findById(gameId);
    if (!game) return;

    // Enforce: betting must be open (fast reject; the commit below is the atomic backstop).
    if (game.roundStatus !== 'betting') {
      socket.emit('betError', { message: 'Betting is closed for this round.' });
      return;
    }

    const user = await User.findById(userId);
    if (!user) return;

    // Compute the validated add/refund using a single integer amount per spot. Removals are
    // clamped to the user's existing stake so a refund can never exceed what was wagered.
    let addAmount = 0;
    let refundAmount = 0;
    const validatedBets = [];

    for (const bet of bets) {
      const { spotId, amount } = bet; // amount already validated as an integer
      const existingBet = game.bets.find(
        (b) => b.userId.toString() === userId && b.spotId === spotId
      );

      if (amount > 0) {
        addAmount += amount;
        validatedBets.push({ spotId, amount });
      } else if (amount < 0) {
        const existingAmount = existingBet ? existingBet.amount : 0;
        const actualRemoval = Math.min(Math.abs(amount), existingAmount);
        if (actualRemoval > 0) {
          refundAmount += actualRemoval;
          validatedBets.push({ spotId, amount: -actualRemoval });
        }
        // Ignore removals for bets that don't exist or exceed the wagered amount.
      }
    }

    // Nothing actionable (e.g. a batch of removals for bets that aren't there).
    if (validatedBets.length === 0) return;

    const netAmount = addAmount - refundAmount;

    // Per-user per-round stake cap (only adds can push a user over the limit).
    const existingUserStake = game.bets
      .filter((b) => b.userId.toString() === userId)
      .reduce((sum, b) => sum + b.amount, 0);
    if (existingUserStake + netAmount > MAX_ROUND_STAKE) {
      socket.emit('betError', { message: 'Round stake limit reached.' });
      return;
    }

    // Pre-image of the current bets (used to roll the bets write back on the fallback path) and
    // the new full bets array (validated deltas merged onto the current bets).
    const preImageBets = game.bets.map((b) => ({ userId: b.userId, spotId: b.spotId, amount: b.amount }));
    const merged = preImageBets.map((b) => ({ userId: b.userId, spotId: b.spotId, amount: b.amount }));
    for (const vb of validatedBets) {
      const existing = merged.find(
        (b) => b.userId.toString() === userId && b.spotId === vb.spotId
      );
      if (existing) {
        existing.amount += vb.amount;
      } else if (vb.amount > 0) {
        merged.push({ userId, spotId: vb.spotId, amount: vb.amount });
      }
    }
    const cleaned = merged.filter((b) => b.amount > 0);

    // Fast reject before any write: if the snapshot already shows insufficient funds there is no
    // point touching the round. The atomic debit guard (debitTickets) is the authoritative check.
    if (netAmount > 0 && user.ticketBalance < netAmount) {
      socket.emit('betError', { message: 'Insufficient tickets for these bets.' });
      return;
    }

    const reason =
      netAmount >= 0
        ? `Bets placed (Batch) - Game #${game.code}`
        : `Bets removed (Batch) - Game #${game.code}`;

    // Commit the wallet move and the game.bets write atomically. Prefer a real transaction
    // (injected when the connection supports one); fall back to bets-first/debit-last with a
    // wrapped+retried reversal on a plain standalone mongod.
    //
    // ABA caveat (unchanged from Phase 1): the roundStatus:'betting' guard on the bets write
    // catches a deal (betting -> resultsPending) landing between our read and our write, but NOT
    // a full deal+clear cycle that returns the round to 'betting' with a fresh bets:[]. The
    // per-game serializer makes that sequence impossible within this process; the residual
    // cross-process window is closed in Phase 3 by guarding on a monotonic game.rev.
    const commitArgs = {
      SrmGame,
      User,
      gameId,
      userId,
      netAmount,
      cleaned,
      preImageBets,
      reason,
      snapshotBalance: user.ticketBalance,
    };
    const result = withTransaction
      ? await commitBetWithTransaction(withTransaction, commitArgs)
      : await commitBetFallback(commitArgs);

    if (!result.ok) {
      socket.emit('betError', { message: result.message });
      return;
    }

    const confirmedBets = validatedBets.map((b) => ({
      userId,
      spotId: b.spotId,
      amount: b.amount,
    }));
    io.to(`srmGame_${gameId}`).emit('betPlacedBatch', { bets: confirmedBets });
    io.to(`srmGame_${gameId}`).emit('ticketUpdate', {
      userId: user._id.toString(),
      username: user.username,
      ticketBalance: result.balance,
    });
  });
}

/** Run `fn` up to `attempts` times, returning its result or throwing the last error. */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Preferred commit path: the wallet debit/credit and the game.bets write run inside one MongoDB
 * transaction (single-node replica set per the §3 decision). Debit first, so insufficient funds
 * or a closed round aborts before anything durable is written; throwing inside the transaction
 * rolls the wallet move back automatically — no manual compensation.
 *
 * Note: session.withTransaction may RE-RUN this callback on a transient transaction error; each
 * re-run re-applies the same pre-read `cleaned`/`netAmount` snapshot against freshly-committed
 * state (the prior attempt was aborted), which is correct under the per-game serializer. The
 * residual cross-process case where another committer changed game.bets is the same window the
 * roundStatus:'betting' guard can't see and that Phase 3's monotonic game.rev guard closes.
 *
 * Returns { ok: true, balance } or { ok: false, message }.
 */
async function commitBetWithTransaction(withTransaction, args) {
  const { SrmGame, User, gameId, userId, netAmount, cleaned, reason, snapshotBalance } = args;
  let balance = snapshotBalance;
  try {
    await withTransaction(async (session) => {
      if (netAmount > 0) {
        const debited = await User.debitTickets(userId, netAmount, reason, { session });
        if (!debited) {
          const e = new Error('insufficient funds');
          e.srmReason = 'Insufficient tickets for these bets.';
          throw e;
        }
        balance = debited.ticketBalance;
      } else if (netAmount < 0) {
        const credited = await User.creditTickets(userId, Math.abs(netAmount), reason, { session });
        balance = credited.ticketBalance;
      }
      const updated = await SrmGame.findOneAndUpdate(
        { _id: gameId, roundStatus: 'betting' },
        { $set: { bets: cleaned } },
        { new: true, session }
      );
      if (!updated) {
        const e = new Error('betting closed');
        e.srmReason = 'Betting closed before your bet was recorded.';
        throw e;
      }
    });
  } catch (err) {
    if (err && err.srmReason) {
      return { ok: false, message: err.srmReason };
    }
    console.error('Bet transaction failed and was rolled back:', err);
    return { ok: false, message: 'Your bet could not be processed. Please try again.' };
  }
  return { ok: true, balance };
}

/**
 * Fallback commit path for a standalone mongod with no transaction support: bets first, wallet
 * last. The bets write is the guarded operation, so the common "betting closed" race no-ops it
 * and the wallet is never touched — no reversal needed. If the wallet move then fails, the bets
 * write is rolled back to its pre-image (wrapped + retried). This is strictly weaker than the
 * transaction path across a cross-process payout race and exists only so a dev box without a
 * replica set still runs; production uses the transaction path.
 *
 * Returns { ok: true, balance } or { ok: false, message }.
 */
async function commitBetFallback(args) {
  const { SrmGame, User, gameId, userId, netAmount, cleaned, preImageBets, reason, snapshotBalance } = args;

  let betsWritten;
  try {
    betsWritten = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: 'betting' },
      { $set: { bets: cleaned } },
      { new: true }
    );
  } catch (err) {
    console.error('Bet commit (bets write) failed; wallet untouched:', err);
    return { ok: false, message: 'Your bet could not be processed. Please try again.' };
  }
  if (!betsWritten) {
    // Round was dealt/cleared before our write. Wallet never touched — nothing to reverse.
    return { ok: false, message: 'Betting closed before your bet was recorded.' };
  }

  // Roll the bets write back to its pre-image. Guarded on roundStatus:'betting' on purpose: we
  // must NOT clobber a concurrent deal/clear that has since changed the round. Within this process
  // the serializer guarantees the round is still 'betting' here, so the reversal applies. The only
  // way it can no-op is a cross-process deal flipping the round between our bets write and this
  // reversal — the documented fallback weakness that Phase 3's game.rev guard closes. We surface
  // that as a loud CRITICAL alarm (rather than swallowing a null result as success) so the
  // resulting uncharged-but-recorded bet is detectable and can be reconciled.
  const reverseBets = () =>
    withRetry(() =>
      SrmGame.findOneAndUpdate(
        { _id: gameId, roundStatus: 'betting' },
        { $set: { bets: preImageBets } },
        { new: true }
      )
    )
      .then((reverted) => {
        if (!reverted) {
          console.error(
            `CRITICAL: bet reversal for game ${gameId} user ${userId} did not apply (round left ` +
              'betting); an uncharged bet may remain recorded — reconcile manually.'
          );
        }
      })
      .catch((err) => {
        console.error('CRITICAL: failed to roll back bets after a wallet failure (possible drift):', err);
      });

  if (netAmount > 0) {
    let debited;
    try {
      debited = await User.debitTickets(userId, netAmount, reason);
    } catch (err) {
      console.error('Bet debit failed; rolling back bets:', err);
      await reverseBets();
      return { ok: false, message: 'Your bet could not be processed. Please try again.' };
    }
    if (!debited) {
      // A concurrent drain emptied the balance after our fast-reject. Undo the bets write.
      await reverseBets();
      return { ok: false, message: 'Insufficient tickets for these bets.' };
    }
    return { ok: true, balance: debited.ticketBalance };
  }

  if (netAmount < 0) {
    let credited;
    try {
      credited = await User.creditTickets(userId, Math.abs(netAmount), reason);
    } catch (err) {
      console.error('Bet refund failed; rolling back bets:', err);
      await reverseBets();
      return { ok: false, message: 'Your bet could not be processed. Please try again.' };
    }
    return { ok: true, balance: credited.ticketBalance };
  }

  // net === 0: bets rearranged with no wallet movement.
  return { ok: true, balance: snapshotBalance };
}

/**
 * Deal handler. Serialized; the betting->resultsPending transition is a guarded
 * findOneAndUpdate so a double-deal (or a deal racing a clear) cannot double-charge or
 * re-shuffle an already-dealt round.
 */
function handleDealCards(deps, socket, data) {
  const { SrmGame, User, io, computePayouts, getShuffledDeckOf54, getOrAssignColor, runSerialized } = deps;
  const { gameId, userId } = data || {};

  if (!gameId) return Promise.resolve();

  return runSerialized(gameId, async () => {
    const game = await SrmGame.findById(gameId);
    if (!game) return;

    // Verify the user is the dealer.
    if (!userId || game.dealer.toString() !== userId) {
      socket.emit('betError', { message: 'Only the dealer can deal cards.' });
      return;
    }

    const deck = getShuffledDeckOf54();
    const chosenCards = deck.slice(0, 3);

    // Atomic, precondition-guarded transition: only deal when still in betting.
    const dealt = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: 'betting' },
      { $set: { dealtCards: chosenCards, roundStatus: 'resultsPending' } },
      { new: true }
    );
    if (!dealt) {
      socket.emit('betError', { message: 'Cards have already been dealt for this round.' });
      return;
    }

    io.to(`srmGame_${gameId}`).emit('cardsDealt', {
      card1: chosenCards[0],
      card2: chosenCards[1],
      card3: chosenCards[2],
    });

    // Compute payouts (credits winners' wallets, emits results).
    await computePayouts(gameId, chosenCards, io);

    // Finalize: resultsPending -> results (guarded; falls back to the dealt snapshot).
    const finalized = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: 'resultsPending' },
      { $set: { roundStatus: 'results' } },
      { new: true }
    );
    const finalGame = finalized || dealt;

    io.to(`srmGame_${gameId}`).emit('gameData', {
      roundStatus: finalGame.roundStatus,
      dealtCards: finalGame.dealtCards,
      bets: finalGame.bets,
      players: await Promise.all(
        finalGame.players.map(async (pId) => {
          const p = await User.findById(pId);
          return {
            userId: p._id.toString(),
            username: p.username,
            ticketBalance: p.ticketBalance,
            color: getOrAssignColor(p._id.toString()),
          };
        })
      ),
    });
  });
}

/**
 * Clear handler. Serialized; the results/resultsPending -> betting reset is a guarded
 * findOneAndUpdate so the round cannot be cleared mid-betting.
 */
function handleClearRound(deps, socket, data) {
  const { SrmGame, io, runSerialized } = deps;
  const { gameId, userId } = data || {};

  if (!gameId) return Promise.resolve();

  return runSerialized(gameId, async () => {
    const game = await SrmGame.findById(gameId);
    if (!game) return;

    // Verify the user is the dealer.
    if (!userId || game.dealer.toString() !== userId) {
      socket.emit('betError', { message: 'Only the dealer can clear the round.' });
      return;
    }

    // Atomic, precondition-guarded reset: only clear from a dealt/results state.
    const cleared = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: { $in: ['results', 'resultsPending'] } },
      { $set: { roundStatus: 'betting', dealtCards: [], bets: [] } },
      { new: true }
    );
    if (!cleared) {
      socket.emit('betError', { message: 'Cannot clear round during betting.' });
      return;
    }

    io.to(`srmGame_${gameId}`).emit('roundCleared');
  });
}

module.exports = {
  createSerializer,
  handlePlayerBetBatch,
  handleDealCards,
  handleClearRound,
};
