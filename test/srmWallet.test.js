// Phase 2.1 unit tests for the atomic wallet primitives. They live in the dependency-free
// services/srmWallet so they can be exercised with a faithful in-memory model and no mongoose,
// like the rest of the SRM money path. The fake's $inc is applied in one synchronous step
// (MongoDB's atomic-update contract); recordTransaction is a no-op here.
const test = require('node:test');
const assert = require('node:assert');
const { creditTickets, debitTickets } = require('../services/srmWallet');

const noopRecord = async () => {};

// findOneAndUpdate applies $inc atomically and honors the debit guard ticketBalance:{$gte:qty}.
function makeAtomicModel(initial) {
  const store = { bal: initial };
  return {
    store,
    async findOneAndUpdate(filter, update, opts = {}) {
      const guard = filter.ticketBalance;
      if (guard && typeof guard === 'object' && '$gte' in guard) {
        if (store.bal < guard.$gte) return null; // insufficient funds → no document matched
      }
      if (update.$inc && typeof update.$inc.ticketBalance === 'number') {
        store.bal += update.$inc.ticketBalance; // read+write with no await in between (atomic)
      }
      return { _id: 'u', ticketBalance: store.bal };
    },
  };
}

const credit = (m, ...args) => creditTickets({ UserModel: m, recordTransaction: noopRecord }, ...args);
const debit = (m, ...args) => debitTickets({ UserModel: m, recordTransaction: noopRecord }, ...args);

test('creditTickets increments the balance and returns the new total', async () => {
  const m = makeAtomicModel(10);
  const updated = await credit(m, 'u', 5, 'add');
  assert.strictEqual(updated.ticketBalance, 15);
  assert.strictEqual(m.store.bal, 15);
});

test('debitTickets decrements when funds suffice', async () => {
  const m = makeAtomicModel(10);
  const updated = await debit(m, 'u', 4, 'spend');
  assert.strictEqual(updated.ticketBalance, 6);
  assert.strictEqual(m.store.bal, 6);
});

test('debitTickets returns null and leaves the balance unchanged when funds are insufficient', async () => {
  const m = makeAtomicModel(3);
  const updated = await debit(m, 'u', 10, 'spend');
  assert.strictEqual(updated, null, 'null signals insufficient funds');
  assert.strictEqual(m.store.bal, 3, 'no partial debit');
});

test('credit/debit reject a non-positive or non-numeric quantity', async () => {
  const m = makeAtomicModel(10);
  await assert.rejects(() => credit(m, 'u', 0, 'x'), /Invalid ticket quantity/);
  await assert.rejects(() => debit(m, 'u', -5, 'x'), /Invalid ticket quantity/);
  await assert.rejects(() => credit(m, 'u', 'abc', 'x'), /Invalid ticket quantity/);
  assert.strictEqual(m.store.bal, 10, 'balance untouched on rejection');
});

test('concurrent credits and debits converge to the correct balance (atomic $inc, no lost update)', async () => {
  const m = makeAtomicModel(1000);
  const ops = [];
  let expected = 1000;
  for (let i = 0; i < 50; i++) {
    ops.push(credit(m, 'u', 3, 'c'));
    expected += 3;
  }
  for (let i = 0; i < 50; i++) {
    ops.push(debit(m, 'u', 2, 'd'));
    expected -= 2;
  }
  await Promise.all(ops);
  assert.strictEqual(m.store.bal, expected, 'every credit and debit applied exactly once');
});

// Operation-SHAPE assertions: pin that the primitives issue a single guarded findOneAndUpdate
// with $inc (not a read-modify-write). A revert to findById -> mutate -> save would fail these
// structurally, which an in-process convergence test alone cannot guarantee.
function makeSpyModel(initial) {
  const calls = [];
  let bal = initial;
  return {
    calls,
    async findOneAndUpdate(filter, update, opts = {}) {
      calls.push({ filter, update, opts });
      const guard = filter.ticketBalance;
      if (guard && typeof guard === 'object' && '$gte' in guard && bal < guard.$gte) return null;
      if (update.$inc && typeof update.$inc.ticketBalance === 'number') bal += update.$inc.ticketBalance;
      return { _id: 'u', ticketBalance: bal };
    },
  };
}

test('debitTickets issues exactly one findOneAndUpdate with a $gte guard and a negative $inc', async () => {
  const m = makeSpyModel(100);
  await debit(m, 'u', 30, 'spend');
  assert.strictEqual(m.calls.length, 1, 'one atomic op, not read-then-write');
  const { filter, update } = m.calls[0];
  assert.deepStrictEqual(filter, { _id: 'u', ticketBalance: { $gte: 30 } }, 'guarded on sufficient funds');
  assert.deepStrictEqual(update, { $inc: { ticketBalance: -30 } }, 'atomic decrement');
});

test('creditTickets issues exactly one findOneAndUpdate with a positive $inc and no balance guard', async () => {
  const m = makeSpyModel(100);
  await credit(m, 'u', 25, 'add');
  assert.strictEqual(m.calls.length, 1);
  const { filter, update } = m.calls[0];
  assert.deepStrictEqual(filter, { _id: 'u' }, 'credit is unconditional');
  assert.deepStrictEqual(update, { $inc: { ticketBalance: 25 } }, 'atomic increment');
});

test('the recorder receives the resulting balance, type, and threaded session', async () => {
  const m = makeAtomicModel(40);
  const recorded = [];
  const recordTransaction = async (entry) => recorded.push(entry);
  const sentinelSession = { id: 'sess-1' };

  await creditTickets({ UserModel: m, recordTransaction }, 'u', 10, 'payout', { session: sentinelSession });
  await debitTickets({ UserModel: m, recordTransaction }, 'u', 15, 'bet', { session: sentinelSession });

  assert.strictEqual(recorded.length, 2);
  assert.deepStrictEqual(
    { type: recorded[0].type, amount: recorded[0].amount, balance: recorded[0].balance, session: recorded[0].session },
    { type: 'add', amount: 10, balance: 50, session: sentinelSession },
    'credit logs the post-credit balance and threads the session for transactional enrollment'
  );
  assert.deepStrictEqual(
    { type: recorded[1].type, amount: recorded[1].amount, balance: recorded[1].balance, session: recorded[1].session },
    { type: 'spend', amount: 15, balance: 35, session: sentinelSession },
    'debit logs the post-debit balance and threads the session'
  );
});

test('an insufficient debit records NOTHING (no ledger row for a debit that did not happen)', async () => {
  const m = makeAtomicModel(5);
  const recorded = [];
  const result = await debitTickets({ UserModel: m, recordTransaction: async (e) => recorded.push(e) }, 'u', 99, 'bet');
  assert.strictEqual(result, null);
  assert.strictEqual(recorded.length, 0, 'no audit row when the guarded debit matched nothing');
});

test('a read-modify-write wallet drifts under the same load (proves the test would catch a regression)', async () => {
  // Models the OLD bug: read balance, yield, write back the (now stale) value. Concurrent ops
  // that read the same value lose all but one update. The atomic $inc above avoids exactly this.
  const store = { bal: 1000 };
  async function rmwCredit(qty) {
    const cur = store.bal; // read
    await Promise.resolve(); // yield — peers interleave here
    store.bal = cur + qty; // write back the stale read
  }
  await Promise.all(Array.from({ length: 50 }, () => rmwCredit(3)));
  assert.ok(store.bal < 1150, `read-modify-write drifted (got ${store.bal}, atomic would be 1150)`);
});
