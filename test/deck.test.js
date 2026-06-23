// Smoke tests for the card deck utility — proves the `node --test` runner is wired up.
// Real regression tests (concurrency, payout math, wallet integrity) land in later phases.
const test = require('node:test');
const assert = require('node:assert');
const { getDeckOf54, getShuffledDeckOf54 } = require('../utils/deck');

test('getDeckOf54 returns 54 cards: 52 standard + 2 jokers', () => {
  const deck = getDeckOf54();
  assert.strictEqual(deck.length, 54);
  assert.strictEqual(deck.filter((c) => c.isJoker).length, 2);
  assert.strictEqual(deck.filter((c) => !c.isJoker).length, 52);
});

test('each suit appears exactly 13 times', () => {
  const deck = getDeckOf54();
  for (const suit of ['♣', '♦', '♥', '♠']) {
    assert.strictEqual(deck.filter((c) => c.suit === suit).length, 13);
  }
});

test('getShuffledDeckOf54 preserves the full multiset of cards', () => {
  const key = (c) => `${c.rank}${c.suit}${c.isJoker}`;
  const sorted = (d) => d.map(key).sort();
  assert.deepStrictEqual(sorted(getShuffledDeckOf54()), sorted(getDeckOf54()));
});
