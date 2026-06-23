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
  const { SrmGame, User, io, runSerialized } = deps;
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

    // Wallet move. (Phase 2 makes this atomic with the bets write; Phase 1 keeps the
    // existing method + an explicit reversal if the guarded commit does not land.)
    if (netAmount > 0) {
      if (user.ticketBalance < netAmount) {
        socket.emit('betError', { message: 'Insufficient tickets for these bets.' });
        return;
      }
      await user.removeTickets(netAmount, `Bets placed (Batch) - Game #${game.code}`);
    } else if (netAmount < 0) {
      await user.addTickets(Math.abs(netAmount), `Bets removed (Batch) - Game #${game.code}`);
    }

    const reverseWallet = async (note) => {
      try {
        if (netAmount > 0) {
          await user.addTickets(netAmount, `Refund - Game #${game.code} ${note}`);
        } else if (netAmount < 0) {
          await user.removeTickets(Math.abs(netAmount), `Reversal - Game #${game.code} ${note}`);
        }
      } catch (revErr) {
        console.error('Critical: failed to reverse wallet after bet commit failure:', revErr);
      }
    };

    // Merge the validated deltas onto a fresh copy of the current bets, then commit the whole
    // array atomically, guarded on roundStatus:'betting'.
    const merged = game.bets.map((b) => ({
      userId: b.userId,
      spotId: b.spotId,
      amount: b.amount,
    }));
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

    // ABA caveat: this guard catches a deal (betting -> resultsPending) landing between our read
    // and our write, but NOT a full deal+clear cycle that returns the round to 'betting' with a
    // fresh bets:[] — that would let this $set resurrect stale bets. The per-game serializer
    // makes that sequence impossible within this process (deal/clear/bet never interleave); the
    // residual cross-process window is closed in Phase 3 by guarding on a monotonic game.rev.
    let updated;
    try {
      updated = await SrmGame.findOneAndUpdate(
        { _id: gameId, roundStatus: 'betting' },
        { $set: { bets: cleaned } },
        { new: true }
      );
    } catch (saveError) {
      console.error('Game bets commit failed, reversing wallet:', saveError);
      await reverseWallet('save failed');
      return;
    }

    if (!updated) {
      // The round was dealt/cleared between our read and our write: no-op + un-charge.
      await reverseWallet('betting closed');
      socket.emit('betError', { message: 'Betting closed before your bet was recorded.' });
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
      ticketBalance: user.ticketBalance,
    });
  });
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
