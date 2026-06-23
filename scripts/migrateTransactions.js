'use strict';

// One-time backfill for Phase 2.3: copy each user's embedded `transactions[]` into the new
// Transaction collection. SAFE TO RE-RUN — each copied event is tagged with `migratedFrom`
// (the embedded subdoc _id), so a second run skips events already migrated. This script does
// NOT delete the embedded arrays; keep them until the new collection is verified, then drop the
// field in a later change.
//
// ALWAYS run against a backup/copy first. Usage:
//   node scripts/migrateTransactions.js --dry-run     # report only, write nothing
//   node scripts/migrateTransactions.js               # perform the backfill
// Honors MONGODB_URI (via .env), same as the app.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Refusing to run without an explicit database URI.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);

  let usersWithHistory = 0;
  let embeddedSeen = 0;
  let inserted = 0;
  let alreadyMigrated = 0;

  // Only users that actually have an embedded ledger entry.
  const cursor = User.find({ 'transactions.0': { $exists: true } })
    .select('transactions')
    .lean()
    .cursor();

  for (let user = await cursor.next(); user != null; user = await cursor.next()) {
    usersWithHistory += 1;
    const embedded = user.transactions || [];
    embeddedSeen += embedded.length;

    // Which of this user's embedded events are already in the collection?
    const ids = embedded.map((t) => t._id).filter(Boolean);
    const existing = ids.length
      ? await Transaction.find({ migratedFrom: { $in: ids } }).select('migratedFrom').lean()
      : [];
    const done = new Set(existing.map((d) => String(d.migratedFrom)));

    const toInsert = [];
    for (const t of embedded) {
      if (t._id && done.has(String(t._id))) {
        alreadyMigrated += 1;
        continue;
      }
      toInsert.push({
        userId: user._id,
        type: t.type,
        amount: t.amount,
        balance: t.balance,
        status: t.status || 'approved',
        reason: t.reason,
        createdAt: t.createdAt || undefined, // let the schema default fill if absent
        migratedFrom: t._id,
      });
    }

    if (toInsert.length && !DRY_RUN) {
      try {
        const res = await Transaction.insertMany(toInsert, { ordered: false });
        inserted += res.length;
      } catch (err) {
        // The unique sparse index on migratedFrom rejects events another run already inserted.
        // With ordered:false the non-duplicate rows still commit; count those, treat the
        // duplicate-key rejections (E11000) as already-migrated rather than failing the run.
        const insertedNow = err.insertedDocs ? err.insertedDocs.length : (err.result?.insertedCount ?? 0);
        const dupes = (err.writeErrors || []).filter((e) => e.code === 11000).length;
        const others = (err.writeErrors || []).filter((e) => e.code !== 11000);
        if (others.length) throw err; // a real error, not just idempotency collisions
        inserted += insertedNow;
        alreadyMigrated += dupes;
      }
    } else {
      inserted += toInsert.length; // dry run: report what would be written
    }
  }

  console.log('--- Migration summary ---');
  console.log(`Users with embedded history : ${usersWithHistory}`);
  console.log(`Embedded events seen        : ${embeddedSeen}`);
  console.log(`Already in collection       : ${alreadyMigrated}`);
  console.log(`${DRY_RUN ? 'Would insert' : 'Inserted'}                : ${inserted}`);

  if (!DRY_RUN) {
    const total = await Transaction.countDocuments({});
    console.log(`Transaction collection total: ${total}`);
  }

  await mongoose.disconnect();
  console.log('Done. Embedded transactions left intact (verify the collection before dropping them).');
}

run().catch(async (err) => {
  console.error('Migration failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
