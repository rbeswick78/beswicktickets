'use strict';

// Trust-boundary validation for "Steal Ryan's Money" bet batches arriving over the socket.
// Pure and dependency-free so it can be unit-tested without a database.
//
// These caps are *robustness* guards (block absurd/overflow values and a compromised or
// runaway client), not gameplay-balance knobs. Chips on the board are 1/5/10/20/50, so both
// limits sit far above any legitimate single action and are safe to tune up if the game's
// economics ever need it.
const MAX_BET = 10000; // max |amount| for a single spot entry in one batch
const MAX_ROUND_STAKE = 100000; // max total positive stake one user may hold on a round

// The board renders cards 1–3, each with the same fixed set of spots. The allowlist is the
// product of {card number} × {known suffix}. Keep this in sync with views/srm/gameBoard.ejs.
const CARD_NUMBERS = ['1', '2', '3'];
const SUITS = ['♦', '♥', '♠', '♣'];
const SUIT_PAIRS = ['♦♥', '♦♠', '♥♣', '♠♣'];
const SIMPLE_SUFFIXES = ['joker', 'odd', 'even', 'ace', 'low', 'mid', 'high'];

function buildAllowedSpotIds() {
  const set = new Set();
  for (const n of CARD_NUMBERS) {
    for (const suit of SUITS) set.add(`card${n}-suit-${suit}`);
    for (const pair of SUIT_PAIRS) set.add(`card${n}-suits-${pair}`);
    for (const suffix of SIMPLE_SUFFIXES) set.add(`card${n}-${suffix}`);
  }
  return set;
}

const ALLOWED_SPOT_IDS = buildAllowedSpotIds();

function isAllowedSpotId(spotId) {
  return typeof spotId === 'string' && ALLOWED_SPOT_IDS.has(spotId);
}

/**
 * Structurally validate a raw bet batch from the socket.
 * Rejects the WHOLE batch (all-or-nothing) unless every entry is well-formed:
 *   - amount is an integer (closes the fractional-mint exploit: amount:1.9)
 *   - |amount| <= MAX_BET
 *   - spotId is in the server-side allowlist
 *   - no spotId appears twice (the legit client aggregates per spot; a duplicate entry would
 *     let two clamped refunds both measure against the same pre-batch stake and mint tickets)
 *
 * @param {Array<{spotId: string, amount: number}>} bets
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateBetBatch(bets) {
  if (!Array.isArray(bets) || bets.length === 0) {
    return { ok: false, reason: 'Malformed bet batch.' };
  }
  const seenSpots = new Set();
  for (const bet of bets) {
    if (!bet || typeof bet !== 'object') {
      return { ok: false, reason: 'Malformed bet entry.' };
    }
    if (!isAllowedSpotId(bet.spotId)) {
      return { ok: false, reason: 'Unknown bet spot.' };
    }
    if (!Number.isInteger(bet.amount) || Math.abs(bet.amount) > MAX_BET) {
      return { ok: false, reason: 'Invalid bet amount.' };
    }
    if (seenSpots.has(bet.spotId)) {
      return { ok: false, reason: 'Duplicate bet spot.' };
    }
    seenSpots.add(bet.spotId);
  }
  return { ok: true };
}

module.exports = {
  MAX_BET,
  MAX_ROUND_STAKE,
  ALLOWED_SPOT_IDS,
  isAllowedSpotId,
  validateBetBatch,
};
