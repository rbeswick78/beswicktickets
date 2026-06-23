'use strict';

// Phase 2.3 transition read: merge a user's wallet history from the new Transaction collection
// with any legacy embedded events not yet backfilled. Pure and dependency-free so it is unit-
// testable; the endpoints fetch from the models and hand the two arrays here.
//
// Why a merge (not "collection if non-empty, else embedded"): after the Phase 2 deploy, the very
// first new wallet event makes the collection non-empty for a user, so an emptiness check would
// permanently hide that user's still-embedded historical events until the migration runs. Here
// the collection is authoritative and we add only embedded events that have NOT been migrated
// (matched by collection.migratedFrom === embedded._id), de-duping the overlap. Both sources are
// then sorted newest-first so the order is consistent regardless of how far migration has run.
function mergeTransactionHistory(collectionTxns, embeddedTxns) {
  const migrated = new Set(
    (collectionTxns || [])
      .map((t) => (t.migratedFrom != null ? String(t.migratedFrom) : null))
      .filter(Boolean)
  );
  const embeddedOnly = (embeddedTxns || []).filter(
    (e) => !(e._id != null && migrated.has(String(e._id)))
  );
  return [...(collectionTxns || []), ...embeddedOnly].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
}

module.exports = { mergeTransactionHistory };
