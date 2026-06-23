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
//
// Phase 3 guarantees (protocol hardening):
//  3.1 The bet confirmation echoes ABSOLUTE per-spot totals ({userId, spotId, total}), not
//      deltas, so a lost/duplicated/reordered frame is self-correcting (the client SETS).
//  3.3 Every committed game mutation advances a monotonic game.rev, and the bet commit is
//      guarded on the rev captured at read — closing the ABA / withTransaction-retry windows
//      the roundStatus guard alone cannot see. A short-lived per-game clientBatchId set makes
//      a duplicate batch idempotent (charged once; the prior confirmation is re-emitted).
//  3.4 The bet handler answers the socket's ack callback with {ok, bets, balance, rev} or
//      {ok:false, reason}.

const { validateBetBatch, MAX_ROUND_STAKE } = require('./srmBetValidation');

// Cap on how many recent clientBatchIds we remember per game (FIFO eviction). One betting round
// produces at most a handful of batches per player, so a few hundred comfortably covers retries
// that span a round boundary while bounding memory for a long-lived game.
const MAX_PROCESSED_BATCHES_PER_GAME = 256;

/**
 * Create an isolated per-game serialization queue. Tasks for the same gameId run strictly
 * one-at-a-time, in enqueue order; a failing task is logged and does not block the queue.
 * `processedBatches` is the per-game idempotency store (gameId -> Map<clientBatchId, confirmation>)
 * the bet handler reads/writes inside the queue.
 */
function createSerializer() {
  const gameQueues = {}; // gameId -> Promise chain
  const processedBatches = {}; // gameId -> Map<clientBatchId, confirmation>

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

  return { runSerialized, gameQueues, processedBatches };
}

/** Look up the stored confirmation for a (gameId, clientBatchId), or null. */
function lookupProcessedBatch(processedBatches, gameId, clientBatchId) {
  if (!processedBatches || !clientBatchId) return null;
  const games = processedBatches[gameId];
  return games ? games.get(clientBatchId) || null : null;
}

/** Record a confirmation for a (gameId, clientBatchId), evicting the oldest beyond the cap. */
function recordProcessedBatch(processedBatches, gameId, clientBatchId, confirmation) {
  if (!processedBatches || !clientBatchId) return;
  let games = processedBatches[gameId];
  if (!games) {
    games = new Map();
    processedBatches[gameId] = games;
  }
  games.set(clientBatchId, confirmation);
  while (games.size > MAX_PROCESSED_BATCHES_PER_GAME) {
    games.delete(games.keys().next().value); // Map preserves insertion order: oldest first
  }
}

/**
 * Build the rev precondition for the bet-commit filter. A legacy game doc that predates the rev
 * field reads back with the schema default 0 in memory, but the stored document has no field, so
 * a bare {rev: 0} would not match it. When the expected rev is 0 we therefore also accept a
 * missing/null field; once any mutation has run, rev exists and an exact match is used.
 */
function revFilterValue(expectedRev) {
  return expectedRev === 0 ? { $in: [0, null] } : expectedRev;
}

/**
 * Batched bet handler. Validates the batch up front (synchronously), then commits inside the
 * per-game queue. The game.bets write is guarded on roundStatus:'betting' AND the rev captured at
 * read; if the round was dealt/cleared (or otherwise mutated) under us the wallet move is reversed
 * and nothing is recorded. A duplicate clientBatchId re-emits the prior confirmation (charged
 * once). The optional `ack` is the Socket.IO acknowledgement callback (Phase 3.4).
 */
function handlePlayerBetBatch(deps, socket, batchData, ack) {
  const { SrmGame, User, io, runSerialized, withTransaction, processedBatches } = deps;
  const { gameId, userId, bets, clientBatchId } = batchData || {};

  const sendAck = (response) => {
    if (typeof ack === 'function') ack(response);
  };

  if (!gameId || !userId) {
    sendAck({ ok: false, reason: 'Malformed bet batch.' });
    return Promise.resolve();
  }

  // Trust-boundary validation (integer amounts, |amount| <= MAX_BET, allowlisted spotIds). This
  // is stateless, so it runs before the queue; we don't dedupe it (a retried malformed batch is
  // harmless — it never reaches the wallet).
  const validation = validateBetBatch(bets);
  if (!validation.ok) {
    socket.emit('betError', { message: validation.reason });
    sendAck({ ok: false, reason: validation.reason });
    return Promise.resolve();
  }

  return runSerialized(gameId, async () => {
    // Idempotency: a duplicate clientBatchId re-emits the prior confirmation to THIS socket only
    // (the original room broadcast already happened) and never re-charges the wallet.
    const prior = lookupProcessedBatch(processedBatches, gameId, clientBatchId);
    if (prior) {
      replayConfirmation(socket, prior, sendAck);
      return;
    }

    // Funnels every exit path through one place: record the confirmation for idempotent replay,
    // then emit it first-time (room broadcast on success, betError on failure) + answer the ack.
    const finish = (confirmation) => {
      recordProcessedBatch(processedBatches, gameId, clientBatchId, confirmation);
      emitConfirmation(io, socket, gameId, confirmation, sendAck);
    };

    const game = await SrmGame.findById(gameId);
    if (!game) {
      sendAck({ ok: false, reason: 'Game not found.' });
      return;
    }
    const expectedRev = game.rev || 0;

    // Enforce: betting must be open (fast reject; the commit below is the atomic backstop).
    if (game.roundStatus !== 'betting') {
      finish(failure('Betting is closed for this round.'));
      return;
    }

    const user = await User.findById(userId);
    if (!user) {
      sendAck({ ok: false, reason: 'Player not found.' });
      return;
    }

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

    // Nothing actionable (e.g. a batch of removals for bets that aren't there). No commit, so rev
    // is unchanged; confirm an empty no-op so a retry replays the same answer.
    if (validatedBets.length === 0) {
      finish(success({ betTotals: [], userId, username: user.username, balance: user.ticketBalance, rev: expectedRev }));
      return;
    }

    const netAmount = addAmount - refundAmount;

    // Per-user per-round stake cap (only adds can push a user over the limit).
    const existingUserStake = game.bets
      .filter((b) => b.userId.toString() === userId)
      .reduce((sum, b) => sum + b.amount, 0);
    if (existingUserStake + netAmount > MAX_ROUND_STAKE) {
      finish(failure('Round stake limit reached.'));
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
      finish(failure('Insufficient tickets for these bets.'));
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
    // The bets write is guarded on BOTH roundStatus:'betting' and rev:expectedRev. The rev guard
    // closes the residual window the roundStatus guard cannot see: a deal+clear cycle returns the
    // round to 'betting' with bets:[], indistinguishable from "no change" by status alone, but rev
    // has advanced — so a stale $set no-ops instead of resurrecting cleared bets. It also defeats
    // the withTransaction-retry stale-snapshot case (a re-run reapplies the pre-read snapshot;
    // if another committer advanced rev meanwhile, the guard rejects rather than commits stale).
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
      expectedRev,
    };
    const result = withTransaction
      ? await commitBetWithTransaction(withTransaction, commitArgs)
      : await commitBetFallback(commitArgs);

    if (!result.ok) {
      finish(failure(result.message));
      return;
    }

    // Absolute per-spot totals for the affected spots (Phase 3.1): the user's new total in the
    // committed bets, or 0 for a spot fully removed. The client SETS these, so a lost/dup/reordered
    // frame self-corrects.
    const betTotals = validatedBets.map((vb) => {
      const entry = cleaned.find((b) => b.userId.toString() === userId && b.spotId === vb.spotId);
      return { userId, spotId: vb.spotId, total: entry ? entry.amount : 0 };
    });

    finish(
      success({
        betTotals,
        userId: user._id.toString(),
        username: user.username,
        balance: result.balance,
        rev: result.rev,
      })
    );
  });
}

/** Build a failure confirmation (no wallet/bets change). */
function failure(reason) {
  return { ok: false, reason, ack: { ok: false, reason } };
}

/**
 * Build a success confirmation carrying everything needed to (a) broadcast absolute chip totals +
 * the new balance to the room, and (b) answer the ack with {ok, bets:[{spotId,total}], balance,
 * rev}. The same object is replayed verbatim on a duplicate clientBatchId.
 */
function success({ betTotals, userId, username, balance, rev }) {
  return {
    ok: true,
    betPlaced: { bets: betTotals, rev },
    ticketUpdate: { userId, username, ticketBalance: balance },
    ack: { ok: true, bets: betTotals.map((b) => ({ spotId: b.spotId, total: b.total })), balance, rev },
  };
}

/** First-time emit: success broadcasts to the room; failure tells the requesting socket. */
function emitConfirmation(io, socket, gameId, confirmation, sendAck) {
  sendAck(confirmation.ack);
  if (confirmation.ok) {
    io.to(`srmGame_${gameId}`).emit('betPlacedBatch', confirmation.betPlaced);
    if (confirmation.ticketUpdate) {
      io.to(`srmGame_${gameId}`).emit('ticketUpdate', confirmation.ticketUpdate);
    }
  } else {
    socket.emit('betError', { message: confirmation.reason });
  }
}

/** Duplicate replay: re-answer the ack and re-emit to the requesting socket only (the original
 *  room broadcast already happened on first processing — absolute totals make a re-send idempotent
 *  for the retrying client without disturbing the rest of the room). */
function replayConfirmation(socket, confirmation, sendAck) {
  sendAck(confirmation.ack);
  if (confirmation.ok) {
    socket.emit('betPlacedBatch', confirmation.betPlaced);
    if (confirmation.ticketUpdate) {
      socket.emit('ticketUpdate', confirmation.ticketUpdate);
    }
  } else {
    socket.emit('betError', { message: confirmation.reason });
  }
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
 * re-run re-applies the same pre-read `cleaned`/`netAmount`/`expectedRev` snapshot against
 * freshly-committed state (the prior attempt was aborted). Because the bets write is guarded on
 * rev:expectedRev, if another committer advanced rev between the original read and a retry the
 * guard rejects (null -> deliberate abort, no further retry) rather than committing a stale
 * snapshot — closing the cross-process / retry window the roundStatus guard alone cannot see.
 *
 * Returns { ok: true, balance, rev } or { ok: false, message }.
 */
async function commitBetWithTransaction(withTransaction, args) {
  const { SrmGame, User, gameId, userId, netAmount, cleaned, reason, snapshotBalance, expectedRev } = args;
  let balance = snapshotBalance;
  let newRev = expectedRev;
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
        { _id: gameId, roundStatus: 'betting', rev: revFilterValue(expectedRev) },
        { $set: { bets: cleaned }, $inc: { rev: 1 } },
        { new: true, session }
      );
      if (!updated) {
        const e = new Error('betting closed');
        e.srmReason = 'Betting closed before your bet was recorded.';
        throw e;
      }
      newRev = updated.rev;
    });
  } catch (err) {
    if (err && err.srmReason) {
      return { ok: false, message: err.srmReason };
    }
    console.error('Bet transaction failed and was rolled back:', err);
    return { ok: false, message: 'Your bet could not be processed. Please try again.' };
  }
  return { ok: true, balance, rev: newRev };
}

/**
 * Fallback commit path for a standalone mongod with no transaction support: bets first, wallet
 * last. The bets write is the guarded operation, so the common "betting closed" race no-ops it
 * and the wallet is never touched — no reversal needed. If the wallet move then fails, the bets
 * write is rolled back to its pre-image (wrapped + retried). This is strictly weaker than the
 * transaction path across a cross-process payout race and exists only so a dev box without a
 * replica set still runs; production uses the transaction path.
 *
 * Returns { ok: true, balance, rev } or { ok: false, message }.
 */
async function commitBetFallback(args) {
  const { SrmGame, User, gameId, userId, netAmount, cleaned, preImageBets, reason, snapshotBalance, expectedRev } = args;

  let betsWritten;
  try {
    betsWritten = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: 'betting', rev: revFilterValue(expectedRev) },
      { $set: { bets: cleaned }, $inc: { rev: 1 } },
      { new: true }
    );
  } catch (err) {
    console.error('Bet commit (bets write) failed; wallet untouched:', err);
    return { ok: false, message: 'Your bet could not be processed. Please try again.' };
  }
  if (!betsWritten) {
    // Round was dealt/cleared (or otherwise mutated — rev advanced) before our write. Wallet never
    // touched — nothing to reverse.
    return { ok: false, message: 'Betting closed before your bet was recorded.' };
  }
  const writtenRev = betsWritten.rev;

  // Roll the bets write back to its pre-image. Guarded on the rev WE just wrote (writtenRev) so we
  // only undo our own write and never clobber a concurrent committer that has since advanced rev.
  // Within this process the serializer guarantees rev is still writtenRev here, so the reversal
  // applies. The only way it can no-op is a cross-process write landing between our bets write and
  // this reversal — the documented fallback weakness. We surface that as a loud CRITICAL alarm
  // (rather than swallowing a null result as success) so the uncharged-but-recorded bet is
  // detectable and can be reconciled.
  const reverseBets = () =>
    withRetry(() =>
      SrmGame.findOneAndUpdate(
        { _id: gameId, rev: writtenRev },
        { $set: { bets: preImageBets }, $inc: { rev: 1 } },
        { new: true }
      )
    )
      .then((reverted) => {
        if (!reverted) {
          console.error(
            `CRITICAL: bet reversal for game ${gameId} user ${userId} did not apply (rev advanced ` +
              'past our write); an uncharged bet may remain recorded — reconcile manually.'
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
    return { ok: true, balance: debited.ticketBalance, rev: writtenRev };
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
    return { ok: true, balance: credited.ticketBalance, rev: writtenRev };
  }

  // net === 0: bets rearranged with no wallet movement.
  return { ok: true, balance: snapshotBalance, rev: writtenRev };
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

    // Atomic, precondition-guarded transition: only deal when still in betting. $inc rev keeps the
    // monotonic revision advancing on every committed game mutation (Phase 3.3).
    const dealt = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: 'betting' },
      { $set: { dealtCards: chosenCards, roundStatus: 'resultsPending' }, $inc: { rev: 1 } },
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
      { $set: { roundStatus: 'results' }, $inc: { rev: 1 } },
      { new: true }
    );
    const finalGame = finalized || dealt;

    io.to(`srmGame_${gameId}`).emit('gameData', {
      roundStatus: finalGame.roundStatus,
      dealtCards: finalGame.dealtCards,
      bets: finalGame.bets,
      rev: finalGame.rev,
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

    // Atomic, precondition-guarded reset: only clear from a dealt/results state. $inc rev advances
    // the monotonic revision; together with the deal/finalize bumps it means a bet that read the
    // pre-clear state cannot match the post-clear rev, so cleared bets can't be resurrected.
    const cleared = await SrmGame.findOneAndUpdate(
      { _id: gameId, roundStatus: { $in: ['results', 'resultsPending'] } },
      { $set: { roundStatus: 'betting', dealtCards: [], bets: [] }, $inc: { rev: 1 } },
      { new: true }
    );
    if (!cleared) {
      socket.emit('betError', { message: 'Cannot clear round during betting.' });
      return;
    }

    io.to(`srmGame_${gameId}`).emit('roundCleared', { rev: cleared.rev });
  });
}

module.exports = {
  createSerializer,
  handlePlayerBetBatch,
  handleDealCards,
  handleClearRound,
};
