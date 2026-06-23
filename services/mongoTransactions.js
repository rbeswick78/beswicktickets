'use strict';

// Runtime detection of MongoDB transaction support, plus a withTransaction helper (Phase 2.2).
// Transactions require a replica set or mongos — per the §3 decision, a single-node replica set
// in production. On a plain standalone mongod they fail with an IllegalOperation error; we probe
// once at startup so the bet handler can fall back to single-document-atomic writes when needed.

function isNoTransactionSupportError(err) {
  if (!err) return false;
  // Standalone mongod rejects with "Transaction numbers are only allowed on a replica set member
  // or mongos" (code 20 / codeName IllegalOperation). Match liberally so an unexpected variant
  // still routes us to the always-safe fallback.
  return (
    err.code === 20 ||
    err.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed/i.test(err.message || '') ||
    /transactions are not supported/i.test(err.message || '')
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Probe the connection by running a trivial read inside a transaction.
//   - commits            => true  (transactions supported)
//   - definitive "no support" (code 20 / IllegalOperation) => false immediately
//   - any other (ambiguous) error => RETRY, then false only after exhausting attempts
// Detection is one-shot at boot, so a transient blip (a real replica set mid-election, a startup
// network/auth hiccup) must NOT be misread as "no support" and permanently pin a transaction-
// capable deployment onto the weaker fallback. Only a positive no-support signal is treated as
// definitive; everything else is retried before we conservatively downgrade.
async function detectTransactionSupport(connection, probeModel, { attempts = 3, delayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let session;
    try {
      session = await connection.startSession();
      await session.withTransaction(async () => {
        await probeModel.findOne({}).session(session);
      });
      return true;
    } catch (err) {
      lastErr = err;
      if (isNoTransactionSupportError(err)) {
        return false; // definitive: this deployment has no transaction support (standalone)
      }
      if (attempt < attempts) await sleep(delayMs);
    } finally {
      if (session) await session.endSession();
    }
  }
  console.error(
    `Transaction support probe inconclusive after ${attempts} attempts; using the non-transactional ` +
      'wallet fallback. Last error:',
    lastErr
  );
  return false;
}

// Build a withTransaction(work) helper bound to a connection. `work(session)` runs inside a
// transaction that commits on success and aborts — rolling back every write made with `session`
// — if `work` throws. The error is rethrown so the caller can map it to a user-facing message.
function buildWithTransaction(connection) {
  return async function withTransaction(work) {
    const session = await connection.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  };
}

module.exports = { detectTransactionSupport, buildWithTransaction, isNoTransactionSupportError };
