// Phase 2.2 unit tests for transaction-support detection (services/mongoTransactions). No DB:
// a fake connection/session/probe model drives the probe outcomes. The key invariant is that a
// transient (ambiguous) failure is RETRIED, while only a positive "no support" signal downgrades
// immediately — so a momentary boot hiccup can't permanently pin a capable deployment to the
// weaker fallback.
const test = require('node:test');
const assert = require('node:assert');
const { detectTransactionSupport, isNoTransactionSupportError } = require('../services/mongoTransactions');

// `outcomes` is a queue of per-attempt behaviors: 'ok' commits; an Error is thrown by the probe
// read (and thus by withTransaction). Tracks how many attempts and endSession calls happened.
function makeConnection(outcomes) {
  const state = { attempts: 0, endSessions: 0 };
  const connection = {
    state,
    async startSession() {
      return {
        async withTransaction(work) {
          state.attempts += 1;
          // Run the work so the probe read decides the outcome, like the real driver.
          return work();
        },
        async endSession() {
          state.endSessions += 1;
        },
      };
    },
  };
  const probeModel = {
    findOne() {
      return {
        async session() {
          const outcome = outcomes.shift();
          if (outcome instanceof Error) throw outcome;
          return null; // 'ok'
        },
      };
    },
  };
  return { connection, probeModel, state };
}

const noSupportErr = () => Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20, codeName: 'IllegalOperation' });
const transientErr = () => Object.assign(new Error('connection timed out'), { code: 89 });

test('isNoTransactionSupportError recognizes the standalone signal and rejects unrelated errors', () => {
  assert.strictEqual(isNoTransactionSupportError(noSupportErr()), true);
  assert.strictEqual(isNoTransactionSupportError(transientErr()), false);
  assert.strictEqual(isNoTransactionSupportError(null), false);
});

test('returns true when the probe transaction commits', async () => {
  const { connection, probeModel, state } = makeConnection(['ok']);
  const supported = await detectTransactionSupport(connection, probeModel, { attempts: 3, delayMs: 0 });
  assert.strictEqual(supported, true);
  assert.strictEqual(state.attempts, 1, 'no retries needed on success');
  assert.strictEqual(state.endSessions, 1, 'session always ended');
});

test('returns false IMMEDIATELY (no retry) on a definitive no-support error', async () => {
  const { connection, probeModel, state } = makeConnection([noSupportErr(), 'ok', 'ok']);
  const supported = await detectTransactionSupport(connection, probeModel, { attempts: 3, delayMs: 0 });
  assert.strictEqual(supported, false);
  assert.strictEqual(state.attempts, 1, 'a standalone is detected on the first attempt, not retried');
});

test('RETRIES an ambiguous/transient failure and succeeds — a boot blip is not a permanent downgrade', async () => {
  const { connection, probeModel, state } = makeConnection([transientErr(), transientErr(), 'ok']);
  const supported = await detectTransactionSupport(connection, probeModel, { attempts: 3, delayMs: 0 });
  assert.strictEqual(supported, true, 'recovered on the third attempt');
  assert.strictEqual(state.attempts, 3);
  assert.strictEqual(state.endSessions, 3, 'each attempt ends its session');
});

test('downgrades to false only after exhausting retries on persistent ambiguous errors', async () => {
  const { connection, probeModel, state } = makeConnection([transientErr(), transientErr(), transientErr()]);
  const supported = await detectTransactionSupport(connection, probeModel, { attempts: 3, delayMs: 0 });
  assert.strictEqual(supported, false);
  assert.strictEqual(state.attempts, 3, 'tried the full budget before conceding');
});
