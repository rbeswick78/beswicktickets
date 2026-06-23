// Unit tests for the pure optimistic-bet reconciler (Phase 4). DOM-free, network-free: this is
// the core state machine the client renders from, exercised here without jsdom (none is available
// — see the SRM test-environment note). The DOM glue in the public/js/srm/ modules (behind the
// srmGameBoard.js entry) is covered by the manual matrix in the plan's §7.
const test = require('node:test');
const assert = require('node:assert');
const { createBetReconciler, nextRevState, aggregateBatch } = require('../public/js/srmBetReconciler');

test('a tap accumulates pending; displayAmount = confirmed + pending, clamped at 0', () => {
  const r = createBetReconciler();
  assert.strictEqual(r.displayAmount('card1-high'), 0, 'unknown spot reads 0');
  assert.strictEqual(r.tap('card1-high', 10), 10);
  assert.strictEqual(r.tap('card1-high', 5), 15, 'pending accumulates');
  assert.strictEqual(r.isPending('card1-high'), true);
});

test('display clamps to 0 when an optimistic removal exceeds the confirmed stake', () => {
  const r = createBetReconciler();
  r.setConfirmed('card1-high', 6);
  r.tap('card1-high', -10); // remove more than is there
  assert.strictEqual(r.displayAmount('card1-high'), 0, 'never renders a negative chip');
});

test('confirm subtracts the exact batch deltas from pending and SETS confirmed from absolute totals', () => {
  const r = createBetReconciler();
  r.tap('card1-high', 10); // pending 10, batch sent
  const affected = r.confirm({ 'card1-high': 10 }, [{ spotId: 'card1-high', total: 10 }]);
  assert.deepStrictEqual(affected, ['card1-high']);
  assert.strictEqual(r.displayAmount('card1-high'), 10, '10 confirmed + 0 pending');
  assert.strictEqual(r.isPending('card1-high'), false, 'no longer pending once acked');
});

test('an IGNORED optimistic removal (absent from the ack) clears its pending instead of leaking it', () => {
  // The classic confirmed-delta-scheme bug: removing from a spot with no stake. The server ignores
  // it, so it is absent from both the echo and the ack totals. Batch association must still clear
  // the pending, or a later add on the same spot would be silently reduced by the stuck -5.
  const r = createBetReconciler();
  r.tap('card1-high', -5); // pending -5, display 0
  assert.strictEqual(r.displayAmount('card1-high'), 0);
  r.confirm({ 'card1-high': -5 }, []); // ack carries NO total for this spot
  assert.strictEqual(r.isPending('card1-high'), false, 'pending cleared by the recorded delta');
  assert.strictEqual(r.tap('card1-high', 10), 10, 'a later add is the full 10, not 5');
});

test('two batches in flight on one spot converge as their acks arrive in commit order', () => {
  const r = createBetReconciler();
  r.tap('card1-high', 10); // batch A: pending 10
  r.tap('card1-high', 5); // batch B: pending 15
  assert.strictEqual(r.displayAmount('card1-high'), 15, 'both shown optimistically');

  r.confirm({ 'card1-high': 10 }, [{ spotId: 'card1-high', total: 10 }]); // ack A
  assert.strictEqual(r.displayAmount('card1-high'), 15, '10 confirmed + 5 still-pending B = 15');
  assert.strictEqual(r.isPending('card1-high'), true, 'B keeps it pending');

  r.confirm({ 'card1-high': 5 }, [{ spotId: 'card1-high', total: 15 }]); // ack B
  assert.strictEqual(r.displayAmount('card1-high'), 15);
  assert.strictEqual(r.isPending('card1-high'), false);
});

test('rollback removes the optimistic deltas and leaves confirmed untouched', () => {
  const r = createBetReconciler();
  r.setConfirmed('card1-high', 8); // an existing confirmed stake
  r.tap('card1-high', 10); // optimistic add on top, display 18
  assert.strictEqual(r.displayAmount('card1-high'), 18);

  const affected = r.rollback({ 'card1-high': 10 }); // rejected
  assert.deepStrictEqual(affected, ['card1-high']);
  assert.strictEqual(r.displayAmount('card1-high'), 8, 'falls back to the confirmed stake');
  assert.strictEqual(r.isPending('card1-high'), false);
});

test('confirm reconciles a MULTI-SPOT batch whose ack omits a server-ignored spot', () => {
  // The real client batches several spots; the ack totals carry only the spots the server changed.
  // tap +10 on a (a real add) and -5 on b (b has no stake -> ignored). The ack confirms only a.
  // confirm must report BOTH spots affected, set a=10, and clear b's pending (its ignored delta).
  const r = createBetReconciler();
  r.tap('a', 10);
  r.tap('b', -5);
  const affected = r.confirm({ a: 10, b: -5 }, [{ spotId: 'a', total: 10 }]).sort();
  assert.deepStrictEqual(affected, ['a', 'b'], 'both touched spots re-render (union of deltas + totals)');
  assert.strictEqual(r.displayAmount('a'), 10);
  assert.strictEqual(r.isPending('a'), false);
  assert.strictEqual(r.displayAmount('b'), 0, "b's ignored removal cleared, no chip");
  assert.strictEqual(r.isPending('b'), false, "b's pending did not leak");
});

test('acks on one spot MUST be applied in commit order; a reversed late ack corrupts confirmed', () => {
  // Documents the ordering invariant the client relies on (single-socket acks arrive in commit
  // order; the ack precedes the room echo). If a LATE ack carrying a now-stale absolute total were
  // applied last, the spot ends wrong. A future change that reorders acks must fail this test.
  const r = createBetReconciler();
  r.tap('s', 10); // batch A
  r.tap('s', 5); // batch B
  // Correct order (A then B) converges to 15:
  const inOrder = createBetReconciler();
  inOrder.tap('s', 10);
  inOrder.tap('s', 5);
  inOrder.confirm({ s: 10 }, [{ spotId: 's', total: 10 }]);
  inOrder.confirm({ s: 5 }, [{ spotId: 's', total: 15 }]);
  assert.strictEqual(inOrder.displayAmount('s'), 15, 'in commit order, converges to the true total');

  // Reversed (B's ack first, then A's stale ack last) lands on A's older absolute total — wrong.
  r.confirm({ s: 5 }, [{ spotId: 's', total: 15 }]); // B acked first
  assert.strictEqual(r.displayAmount('s'), 25, 'transient over-count while A still pending');
  r.confirm({ s: 10 }, [{ spotId: 's', total: 10 }]); // A's stale ack arrives last
  assert.strictEqual(r.displayAmount('s'), 10, 'reversed acks corrupt — proves order-dependence');
});

test('confirm reconciles a clamped removal: optimistic -10 against a 6 stake settles to total 0', () => {
  const r = createBetReconciler();
  r.setConfirmed('card1-high', 6);
  r.tap('card1-high', -10); // over-remove optimistically
  assert.strictEqual(r.displayAmount('card1-high'), 0);
  r.confirm({ 'card1-high': -10 }, [{ spotId: 'card1-high', total: 0 }]); // server clamped to -6
  assert.strictEqual(r.displayAmount('card1-high'), 0, 'spot is gone');
  assert.strictEqual(r.isPending('card1-high'), false);
});

test('a room echo for this user SETS confirmed without disturbing a later batch still pending', () => {
  const r = createBetReconciler();
  r.tap('card1-high', 10); // batch A optimistic
  r.confirm({ 'card1-high': 10 }, [{ spotId: 'card1-high', total: 10 }]); // batch A acked: confirmed 10
  r.tap('card1-high', 5); // batch B optimistic: display 15
  r.setConfirmed('card1-high', 10); // echo for batch A arrives late — idempotent
  assert.strictEqual(r.displayAmount('card1-high'), 15, '10 confirmed + 5 pending B');
});

test('resyncFrom drops all pending, seeds confirmed from server truth, and bumps the generation', () => {
  const r = createBetReconciler();
  const g0 = r.getGeneration();
  r.tap('card1-high', 10);
  r.tap('card2-joker', 3); // optimistic, never acked
  const g1 = r.resyncFrom([{ spotId: 'card1-high', total: 7 }]);
  assert.strictEqual(g1, g0 + 1, 'generation advanced');
  assert.strictEqual(r.displayAmount('card1-high'), 7, 'seeded from server truth');
  assert.strictEqual(r.isPending('card1-high'), false, 'pending dropped');
  assert.strictEqual(r.displayAmount('card2-joker'), 0, 'unmentioned optimistic spot cleared');
});

test('a stale ack applied after a resync would be discarded by the generation guard (caller contract)', () => {
  // The reconciler exposes getGeneration(); the caller captures it at send and ignores an ack whose
  // generation no longer matches. This asserts the value the caller compares against changes.
  const r = createBetReconciler();
  const sentGen = r.getGeneration();
  r.resyncFrom([]); // a reconnect/error resync lands while a batch is in flight
  assert.notStrictEqual(r.getGeneration(), sentGen, 'the in-flight batch is now stale');
});

// ---- batch aggregation (the wire payload + the per-spot deltas the caller reconciles by) ----

test('aggregateBatch sums taps per spot into one net delta', () => {
  const { finalBets, deltas } = aggregateBatch([
    { spotId: 'a', amount: 10 },
    { spotId: 'a', amount: 5 },
  ]);
  assert.deepStrictEqual(finalBets, [{ spotId: 'a', amount: 15 }]);
  assert.deepStrictEqual(deltas, { a: 15 });
});

test('aggregateBatch omits a spot that nets to zero entirely (no round-trip, no {spot:0} delta)', () => {
  const { finalBets, deltas } = aggregateBatch([
    { spotId: 'a', amount: 10 },
    { spotId: 'a', amount: -10 }, // a nets to 0
    { spotId: 'b', amount: 5 },
  ]);
  assert.deepStrictEqual(finalBets, [{ spotId: 'b', amount: 5 }], 'only b is sent');
  assert.deepStrictEqual(deltas, { b: 5 }, 'no {a:0} leaks into the reconciliation deltas');
});

test('aggregateBatch of an all-cancelling input yields nothing to send', () => {
  const { finalBets, deltas } = aggregateBatch([
    { spotId: 'a', amount: 5 },
    { spotId: 'a', amount: -5 },
  ]);
  assert.deepStrictEqual(finalBets, []);
  assert.deepStrictEqual(deltas, {});
});

test('aggregateBatch is order-independent for the per-spot sum', () => {
  const a = aggregateBatch([{ spotId: 'x', amount: 3 }, { spotId: 'x', amount: -1 }, { spotId: 'x', amount: 4 }]);
  const b = aggregateBatch([{ spotId: 'x', amount: 4 }, { spotId: 'x', amount: 3 }, { spotId: 'x', amount: -1 }]);
  assert.deepStrictEqual(a.deltas, b.deltas);
  assert.deepStrictEqual(a.deltas, { x: 6 });
});

// ---- rev-gap detection ----

test('nextRevState: the first observation establishes the baseline with no gap', () => {
  assert.deepStrictEqual(nextRevState(null, 5), { lastRev: 5, gap: false });
});

test('nextRevState: a +1 advance is contiguous (no gap)', () => {
  assert.deepStrictEqual(nextRevState(5, 6), { lastRev: 6, gap: false });
});

test('nextRevState: the smallest gap (lastRev+2) flips gap true and advances lastRev', () => {
  // Boundary that guards the off-by-one in `incomingRev > lastRev + 1` (a single missed broadcast).
  assert.deepStrictEqual(nextRevState(5, 7), { lastRev: 7, gap: true });
});

test('nextRevState: a jump of more than 1 is a gap and advances lastRev', () => {
  assert.deepStrictEqual(nextRevState(5, 8), { lastRev: 8, gap: true });
});

test('nextRevState: a stale or duplicate rev is ignored (absolute SET self-heals it)', () => {
  assert.deepStrictEqual(nextRevState(5, 5), { lastRev: 5, gap: false });
  assert.deepStrictEqual(nextRevState(5, 3), { lastRev: 5, gap: false });
});

test('nextRevState: a non-numeric rev leaves state unchanged', () => {
  assert.deepStrictEqual(nextRevState(5, undefined), { lastRev: 5, gap: false });
  assert.deepStrictEqual(nextRevState(null, undefined), { lastRev: null, gap: false });
});
