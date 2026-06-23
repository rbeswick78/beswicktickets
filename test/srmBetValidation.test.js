// Trust-boundary validation tests (Phase 1.3). Pure — no DB required.
const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_BET,
  MAX_ROUND_STAKE,
  ALLOWED_SPOT_IDS,
  isAllowedSpotId,
  validateBetBatch,
} = require('../services/srmBetValidation');

test('a fractional bet (amount: 1.9) is rejected', () => {
  // Regression: previously amount:1.9 was charged as 1 (parseInt) but paid out on 1.9 — minting.
  const result = validateBetBatch([{ spotId: 'card1-high', amount: 1.9 }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /amount/i);
});

test('integer amounts within MAX_BET on allowlisted spots are accepted', () => {
  const result = validateBetBatch([
    { spotId: 'card1-high', amount: 5 },
    { spotId: 'card2-suits-♦♥', amount: -3 },
    { spotId: 'card3-joker', amount: MAX_BET },
  ]);
  assert.deepStrictEqual(result, { ok: true });
});

test('an amount exceeding MAX_BET is rejected', () => {
  const result = validateBetBatch([{ spotId: 'card1-high', amount: MAX_BET + 1 }]);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /amount/i);
});

test('a negative amount beyond -MAX_BET is rejected', () => {
  const result = validateBetBatch([{ spotId: 'card1-high', amount: -(MAX_BET + 1) }]);
  assert.strictEqual(result.ok, false);
});

test('an unknown spotId is rejected', () => {
  for (const spotId of ['card4-high', 'card1-bogus', 'card1-suit-X', 'card1-suits-♦♦', 'totally-made-up', '']) {
    const result = validateBetBatch([{ spotId, amount: 1 }]);
    assert.strictEqual(result.ok, false, `expected ${JSON.stringify(spotId)} to be rejected`);
    assert.match(result.reason, /spot/i);
  }
});

test('one bad entry rejects the whole batch (all-or-nothing)', () => {
  const result = validateBetBatch([
    { spotId: 'card1-high', amount: 5 },
    { spotId: 'card1-low', amount: 2.5 }, // bad
  ]);
  assert.strictEqual(result.ok, false);
});

test('duplicate spotIds in one batch are rejected (anti-mint)', () => {
  // Two clamped refunds for the same spot would each measure against the same pre-batch stake.
  const result = validateBetBatch([
    { spotId: 'card1-high', amount: -10 },
    { spotId: 'card1-high', amount: -10 },
  ]);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /duplicate/i);
});

test('non-numeric / NaN / Infinity amounts are rejected', () => {
  for (const amount of ['5', NaN, Infinity, -Infinity, null, undefined, {}]) {
    const result = validateBetBatch([{ spotId: 'card1-high', amount }]);
    assert.strictEqual(result.ok, false, `expected amount ${String(amount)} to be rejected`);
  }
});

test('malformed batches (non-array, empty, non-object entries) are rejected', () => {
  assert.strictEqual(validateBetBatch(undefined).ok, false);
  assert.strictEqual(validateBetBatch(null).ok, false);
  assert.strictEqual(validateBetBatch([]).ok, false);
  assert.strictEqual(validateBetBatch('nope').ok, false);
  assert.strictEqual(validateBetBatch([null]).ok, false);
  assert.strictEqual(validateBetBatch([42]).ok, false);
});

test('allowlist contains exactly the 45 board spots (3 cards × 15 spots)', () => {
  assert.strictEqual(ALLOWED_SPOT_IDS.size, 45);
  // spot-check a representative from each family
  assert.ok(isAllowedSpotId('card1-suit-♦'));
  assert.ok(isAllowedSpotId('card2-suits-♠♣'));
  assert.ok(isAllowedSpotId('card3-ace'));
  assert.ok(isAllowedSpotId('card1-even'));
  assert.ok(!isAllowedSpotId('card1-suits-♥♠')); // not one of the rendered pairs
});

test('caps are sane positive integers (MAX_BET <= MAX_ROUND_STAKE)', () => {
  assert.ok(Number.isInteger(MAX_BET) && MAX_BET > 0);
  assert.ok(Number.isInteger(MAX_ROUND_STAKE) && MAX_ROUND_STAKE > 0);
  assert.ok(MAX_BET <= MAX_ROUND_STAKE);
});
