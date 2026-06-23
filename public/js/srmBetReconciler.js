/* srmBetReconciler.js — pure optimistic-bet reconciliation for "Steal Ryan's Money".
 *
 * This is the DOM-free, network-free core of Phase 4's optimistic chip rendering. It tracks, for
 * the CURRENT USER only, a per-spot { confirmed, pending } pair and derives the absolute amount to
 * display. The server is authoritative and echoes ABSOLUTE per-spot totals (Phase 3.1), so the UI
 * always converges by SETTING, never adding.
 *
 *   confirmed — the latest server-confirmed absolute stake on this spot (from the bet ack's
 *               bets[].total, or the room betPlacedBatch echo for this user).
 *   pending   — the net of locally-tapped deltas not yet reconciled to a server confirmation.
 *
 *   displayAmount(spot) = max(0, confirmed + pending)
 *
 * Reconciliation is BATCH-ASSOCIATED, not echo-delta based: a batch records the exact per-spot
 * deltas it sent, and on its ack we subtract those exact deltas from `pending` (and set `confirmed`
 * from the ack's absolute totals). This is the only correct way to clear an optimistic removal the
 * server IGNORED (e.g. removing from a spot with no stake): such a spot is absent from the echo and
 * the ack totals, so a confirmed-delta scheme would leak its pending forever — subtracting the
 * recorded batch delta cannot.
 *
 * UMD: loads as a classic <script> in the browser (sets window.SrmBet) and via require() in the
 * node:test suite. No dependencies, no DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SrmBet = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Create an isolated reconciler for one player's optimistic bet state.
   */
  function createBetReconciler() {
    const spots = new Map(); // spotId -> { confirmed, pending }
    let generation = 0; // bumped on every full resync so stale in-flight acks can be discarded

    function entry(spotId) {
      let e = spots.get(spotId);
      if (!e) {
        e = { confirmed: 0, pending: 0 };
        spots.set(spotId, e);
      }
      return e;
    }

    /** Absolute amount to render for this spot (never negative). */
    function displayAmount(spotId) {
      const e = spots.get(spotId);
      if (!e) return 0;
      return Math.max(0, e.confirmed + e.pending);
    }

    /** True when the spot carries an unreconciled optimistic delta (render it as "unconfirmed"). */
    function isPending(spotId) {
      const e = spots.get(spotId);
      return !!e && e.pending !== 0;
    }

    /** A local optimistic tap (+amount to add, -amount to remove). Returns the new display amount. */
    function tap(spotId, amount) {
      entry(spotId).pending += amount;
      return displayAmount(spotId);
    }

    /**
     * Confirm a batch: remove its optimistic deltas from `pending` and SET `confirmed` from the
     * server's absolute totals. `deltas` is { spotId: netDelta } (every spot the batch touched);
     * `totals` is [{ spotId, total }] (only the spots the server actually changed). Returns the
     * affected spotIds so the caller can re-render exactly those chips.
     */
    function confirm(deltas, totals) {
      const affected = new Set();
      for (const spotId of Object.keys(deltas || {})) {
        entry(spotId).pending -= deltas[spotId];
        affected.add(spotId);
      }
      for (const t of totals || []) {
        entry(t.spotId).confirmed = t.total;
        affected.add(t.spotId);
      }
      return Array.from(affected);
    }

    /**
     * Roll a batch back (ack {ok:false} / timeout): remove its optimistic deltas from `pending`,
     * leaving `confirmed` untouched (the server recorded no change). Returns the affected spotIds.
     */
    function rollback(deltas) {
      const affected = [];
      for (const spotId of Object.keys(deltas || {})) {
        entry(spotId).pending -= deltas[spotId];
        affected.push(spotId);
      }
      return affected;
    }

    /** Idempotently SET a spot's confirmed total from a room echo for this user. */
    function setConfirmed(spotId, total) {
      entry(spotId).confirmed = total;
    }

    /**
     * Full resync to absolute server truth: drop ALL optimistic state, seed `confirmed` from the
     * server's bet list, and bump the generation so any in-flight batch ack is discarded rather
     * than applied against the new baseline. `confirmedList` is [{ spotId, total }].
     */
    function resyncFrom(confirmedList) {
      spots.clear();
      for (const c of confirmedList || []) {
        entry(c.spotId).confirmed = c.total;
      }
      generation += 1;
      return generation;
    }

    function getGeneration() {
      return generation;
    }

    return {
      tap,
      confirm,
      rollback,
      setConfirmed,
      resyncFrom,
      getGeneration,
      displayAmount,
      isPending,
    };
  }

  /**
   * Aggregate a list of optimistic taps ([{spotId, amount}], in tap order) into one net delta per
   * spot for a single batch. Spots whose net is exactly zero (a tap then an equal untap) are omitted
   * entirely — they need no round-trip, and emitting a 0-delta would make the reconciler record a
   * pending it has to clear later. Returns the wire payload AND the per-spot deltas the caller
   * stores to reconcile the batch's pending on ack.
   *
   * Pure, so the load-bearing zero-net filter is unit-tested without a DOM.
   * @returns {{ finalBets: Array<{spotId:string, amount:number}>, deltas: Object<string,number> }}
   */
  function aggregateBatch(taps) {
    const summed = {};
    for (const t of taps || []) {
      summed[t.spotId] = (summed[t.spotId] || 0) + t.amount;
    }
    const finalBets = [];
    const deltas = {};
    for (const spotId of Object.keys(summed)) {
      if (summed[spotId] === 0) continue; // a tap+untap that netted to zero needs no round-trip
      finalBets.push({ spotId, amount: summed[spotId] });
      deltas[spotId] = summed[spotId];
    }
    return { finalBets, deltas };
  }

  /**
   * Revision-gap detection (Phase 4.4). The server bumps a monotonic game.rev on every committed
   * mutation and stamps it on the betPlacedBatch echo every room member receives. During betting
   * consecutive bet commits advance rev by exactly 1, so an incoming rev more than 1 past the last
   * one we applied means we missed at least one broadcast — a spot we DIDN'T see may have changed,
   * so the caller should pull a full resync. Absolute echoes already self-heal the spots we DO see;
   * this only catches the ones we don't.
   *
   * Stale/duplicate revs (<= lastRev) are ignored — absolute SET makes a reordered frame harmless.
   * The first observation just establishes the baseline.
   *
   * @returns {{ lastRev: number|null, gap: boolean }}
   */
  function nextRevState(lastRev, incomingRev) {
    if (typeof incomingRev !== 'number' || Number.isNaN(incomingRev)) {
      return { lastRev: lastRev == null ? null : lastRev, gap: false };
    }
    if (lastRev == null) {
      return { lastRev: incomingRev, gap: false };
    }
    if (incomingRev <= lastRev) {
      return { lastRev, gap: false };
    }
    return { lastRev: incomingRev, gap: incomingRev > lastRev + 1 };
  }

  return { createBetReconciler, nextRevState, aggregateBatch };
});
