// Phase 2.3 unit tests for the transaction-history merge (services/transactionHistory). Pure —
// no DB. Covers the transition-window correctness: the collection is authoritative, embedded
// events not yet migrated are still surfaced, migrated ones are not duplicated, and the combined
// list is consistently newest-first regardless of how far the backfill has run.
const test = require('node:test');
const assert = require('node:assert');
const { mergeTransactionHistory } = require('../services/transactionHistory');

const d = (s) => new Date(s);

test('returns collection rows newest-first when there is no embedded history', () => {
  const coll = [
    { type: 'add', amount: 5, createdAt: d('2026-01-01') },
    { type: 'spend', amount: 2, createdAt: d('2026-03-01') },
  ];
  const out = mergeTransactionHistory(coll, []);
  assert.deepStrictEqual(out.map((t) => t.amount), [2, 5], 'newest (March) first');
});

test('surfaces embedded events that have not been migrated (collection non-empty but incomplete)', () => {
  // After deploy, a new collection row exists, but the user still has older embedded-only history.
  const coll = [{ type: 'spend', amount: 9, createdAt: d('2026-05-01') }]; // a fresh live event, no migratedFrom
  const embedded = [
    { _id: 'e1', type: 'add', amount: 100, createdAt: d('2026-01-01') },
    { _id: 'e2', type: 'add', amount: 50, createdAt: d('2026-02-01') },
  ];
  const out = mergeTransactionHistory(coll, embedded);
  assert.strictEqual(out.length, 3, 'all three events shown — embedded history not hidden');
  assert.deepStrictEqual(out.map((t) => t.amount), [9, 50, 100], 'merged and sorted newest-first');
});

test('does not duplicate an embedded event that was already migrated', () => {
  const coll = [
    { type: 'add', amount: 100, createdAt: d('2026-01-01'), migratedFrom: 'e1' }, // backfilled copy of e1
    { type: 'spend', amount: 9, createdAt: d('2026-05-01') },
  ];
  const embedded = [
    { _id: 'e1', type: 'add', amount: 100, createdAt: d('2026-01-01') }, // still present in the embedded array
    { _id: 'e2', type: 'add', amount: 50, createdAt: d('2026-02-01') }, // not yet migrated
  ];
  const out = mergeTransactionHistory(coll, embedded);
  assert.strictEqual(out.length, 3, 'e1 appears once (via collection), e2 added from embedded');
  const e1count = out.filter((t) => t.amount === 100).length;
  assert.strictEqual(e1count, 1, 'the migrated event is not duplicated');
  assert.deepStrictEqual(out.map((t) => t.amount), [9, 50, 100], 'newest-first');
});

test('handles empty / missing inputs', () => {
  assert.deepStrictEqual(mergeTransactionHistory([], []), []);
  assert.deepStrictEqual(mergeTransactionHistory(undefined, undefined), []);
  assert.deepStrictEqual(mergeTransactionHistory([], undefined), []);
});

test('ObjectId-like migratedFrom matches an ObjectId-like embedded _id by string value', () => {
  const oid = (s) => ({ toString: () => s });
  const coll = [{ type: 'add', amount: 7, createdAt: d('2026-01-01'), migratedFrom: oid('e1') }];
  const embedded = [{ _id: oid('e1'), type: 'add', amount: 7, createdAt: d('2026-01-01') }];
  const out = mergeTransactionHistory(coll, embedded);
  assert.strictEqual(out.length, 1, 'matched by String() value despite being objects, not ===');
});
