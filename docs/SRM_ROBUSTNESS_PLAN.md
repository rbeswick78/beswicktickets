# Steal Ryan's Money — Robustness & Code-Quality Plan

> Status: **in progress** (see Progress log). Derived from the verified multi-agent review
> (29 findings, adversarially checked against the code). Item tags like **(R①)** cross-reference
> the review findings. Sequenced by best engineering judgment: shrink the surface area first,
> fix real money/data loss next, then perceived loss, then structure.
>
> **Workflow: one phase per session.** Each session (1) reads this doc, (2) implements one
> phase, (3) commits it to a branch, (4) updates the Progress log below, and (5) ends with a
> copy-paste handoff prompt for the next session. This doc is the durable source of truth — a
> new session has none of the prior chat context, so anything that must survive lives here.

## 0. Progress log

| Phase | Status | Notes |
|-------|--------|-------|
| 0 — Foundations & dead-code removal | ✅ Complete (2026-06-23) | ~−496 net lines. Removed dead `playerBet`/`removeBet` handlers + legacy results modal + `showPayoutResults`/`triggerConfetti` + write-only state; added `SPOT_CLASS_RULES`/`spotClass` (single source of truth) and `TIMING` constants; gated `dbg()` logger; de-duped `showSummaryPanel`; fixed `srmPayoutService.js` header; added `node --test` + deck smoke test. Verified: `node --check` clean, `npm test` 3/3, grep sweep. **Not** run against the live app (no local MongoDB). |
| 1 — Stop real bet loss & exploit | ⬜ Not started | **Next up.** Serialize `dealCards`/`clearRound`; atomic status-guarded `findOneAndUpdate`; server-side bet validation (`Number.isInteger`, `MAX_BET`, spotId allowlist, one rounded value for wallet+bets). |
| 2 — Wallet integrity | ⬜ Not started | Needs the replica-set decision (see §3 infra prerequisites). |
| 3 — Protocol hardening | ⬜ Not started | Absolute-total echoes, `spotId` in results, idempotency, acks. |
| 4 — Client responsiveness | ⬜ Not started | Depends on Phase 3. Optimistic chips, pointer events, reconnect resync. |
| 5 — Structural refactor | ⬜ Not started | Module split. Do last. |

**Phase 0 commit state:** committed on branch `srm-phase0-cleanup` (not pushed; commit `ccc1b30`). Includes `docs/SRM_ROBUSTNESS_PLAN.md` and `test/deck.test.js`. Phase 1 should branch from `main` after this merges, or continue on this branch if reviewing as a stack.

## 1. Problem statement

The reported symptom — "rapid taps don't all get logged, some bets don't go through" — is
actually **two distinct problems** that the review separated:

1. **Real bet loss (server).** A bet batch in flight when the dealer hits **Deal** can be
   charged to the player but dropped from `game.bets`, because `dealCards`/`clearRound`
   mutate the same document outside the serialization queue. This is genuine ticket loss.
2. **Perceived loss (client).** A tapped chip does not appear until a 200 ms debounce + a
   full server round-trip; rejected batches vanish with only a generic toast. The player
   taps, sees nothing on the felt, and concludes the tap was missed.

A frequently-assumed third cause — `click` vs `pointerdown` event coalescing — was
**downgraded** by verification: the viewport (`user-scalable=no`) and `touch-action:
manipulation` already neutralize most tap coalescing. Switching to `pointerdown` is still
worth doing for latency, but it is **not** the root cause and must not be mistaken for the fix.

Alongside these, the review surfaced real money-integrity defects (a fractional-bet minting
exploit, non-atomic wallet writes, lost-update races) and a large body of dead/duplicated
code worth removing.

## 2. Goals & non-goals

**Goals**
- No bet is ever charged-but-dropped, under any tap/deal timing.
- Server state is the single source of truth; the client always converges to it.
- Every tap gets immediate on-spot feedback; rejections are explained, not silent.
- Wallet and bets move atomically; no client value can desync the two.
- The codebase is readable enough that the next change is obvious and low-risk.

**Non-goals (this plan)**
- No gameplay/rules changes (payout multipliers, bet types stay as-is).
- No visual redesign beyond feedback affordances.
- No auth/account changes.

## 3. Cross-cutting decisions (apply across phases)

- **Server-authoritative, absolute state.** The server stops echoing deltas and instead
  echoes the *new total* per spot and an authoritative balance. The client *sets*, never
  *adds*. This makes every lost/duplicated/reordered message self-healing. (R④, R⑦-sync)
- **Atomic single-document writes.** Replace read-modify-write (`findById` → mutate →
  `save()`) with guarded `findOneAndUpdate` using `$inc`/`$push`/`$set` and the precondition
  in the query filter. This removes lost-update races and closes TOCTOU windows even if
  serialization is ever bypassed. (R①, R⑩, R⑰)
- **Idempotency.** Every money-moving message carries a `clientBatchId` (we already depend on
  `uuid`); the server dedupes within the per-game queue and re-emits the prior confirmation
  on a duplicate. (R⑨, R⑪-sync)
- **Optimistic-with-reconciliation UI.** The client renders immediately on tap but treats
  that as provisional, reconciling to the server's absolute state on ack/echo/error. (R⑤)
- **Validation at the trust boundary.** All amounts/spotIds from the socket are validated and
  normalized to one integer value used for *both* wallet and bets. (R⑧)

### Infrastructure prerequisites
- **MongoDB transactions need a replica set.** `config/db.js` points at a bare
  `mongodb://…:27017` with no `replicaSet`. Phase 2's atomic wallet+bet write is best done
  with `session.withTransaction`, which requires a replica set (a single-node RS is fine).
  If converting infra is undesirable now, Phase 2 has a transaction-free fallback (bets-first,
  debit-last, guaranteed reversal) — but the real fix is a transaction. **Decision needed
  before Phase 2.**
- **No test runner exists.** Introduce one in Phase 0 (recommended: Node's built-in
  `node:test` + `node --test`, zero new deps) so each subsequent phase ships with regression
  tests for the race/exploit it closes.

## 4. Phased delivery

Each phase is an independently shippable PR. Phases 1–2 resolve the reported bug at the data
layer; Phase 4 resolves the *felt* responsiveness. Phase 0 is deliberately first because it
removes a whole dead protocol and centralizes helpers, which makes every later diff smaller
and safer.

---

### Phase 0 — Foundations & dead-code removal *(low risk, no behavior change)* — ✅ COMPLETE (2026-06-23)

Rationale: do this first. It deletes ~360 lines and an entire unused single-bet protocol, so
later phases only have to reason about one path.

| # | Item | Review | Files |
|---|------|--------|-------|
| 0.1 | Delete dead legacy code: `showPayoutResults`, `triggerConfetti`, the hidden `#payout-results` modal markup + its close-button wiring; server `playerBet` & `removeBet` handlers and the `betPlaced` emit; client `betPlaced`/`betRemoved` listeners; dead state (`payoutResultsCache`, `finishedDealing`). | R⑫ | `public/js/srmGameBoard.js`, `app.js`, `views/srm/gameBoard.ejs` |
| 0.2 | Single source of truth for spot→selector: one `SPOT_CLASS_RULES` table + `getBetSpotElement(spotId)` / `getChipElement(spotId,userId)`; replace the 4 duplicated if/else chains. | R⑬ | `public/js/srmGameBoard.js` |
| 0.3 | `TIMING` constants block; pull CSS-coupled durations (card flip, chip settle) from CSS custom properties so JS/CSS can't silently desync. Add `MAX_BET` / per-round cap constants for later use. | R⑯ | `public/js/srmGameBoard.js`, `public/css/srm.css` |
| 0.4 | Gated logger (`const DEBUG=false; log=(...a)=>DEBUG&&console.log(...a)`); keep `console.error` on failure paths and the missing-chip `console.warn`. Fix stale header `rdsPayoutService.js` → `srmPayoutService.js`; delete apology/thinking-out-loud comments. | R⑯ | `public/js/srmGameBoard.js`, `services/srmPayoutService.js`, `app.js` |
| 0.5 | De-duplicate the desktop/mobile blocks in `showSummaryPanel` into one config-parameterized renderer + `netClass`/`signed` helpers. | R⑯ | `public/js/srmGameBoard.js` |
| 0.6 | Add test scaffolding (`node --test`, a `test` npm script, a `test/` dir). No tests yet beyond a smoke test. | — | `package.json`, `test/` |

**DoD:** app behaves identically; grep confirms removed symbols have no remaining references;
`npm test` runs.

---

### Phase 1 — Stop real bet loss & the minting exploit *(critical; server correctness)*

This is the phase that fixes the user's reported "taps near deal don't go through" at the
data layer. Ship it early.

| # | Item | Review | Approach |
|---|------|--------|----------|
| 1.1 | Serialize `dealCards` & `clearRound` through the same `runSerialized(gameId,…)` queue as bets. | R①, R⑱-sync | Wrap both handler bodies; deal/clear can no longer interleave with an in-flight batch. |
| 1.2 | Make state transitions atomic + precondition-guarded. | R①, R⑰ | Deal: `findOneAndUpdate({_id, roundStatus:'betting'}, {$set:{dealtCards, roundStatus:'resultsPending'}}, {new:true})`; treat `null` as "state changed under us." Clear: analogous guard on `{roundStatus:{$in:['results','resultsPending']}}`. Bet commit: include `roundStatus:'betting'` in the update filter so a late bet no-ops instead of resurrecting a dealt round. |
| 1.3 | Server-side bet validation & normalization. | R⑧ | Reject the whole batch unless every `amount` is `Number.isInteger` and `Math.abs(amount) <= MAX_BET`, and every `spotId` is in a server-side allowlist (derive from card number × known suffixes). Use one rounded integer for *both* the wallet debit and `game.bets`. Add a per-user per-round stake cap. Emit a specific `betError` on violation. |

**Tests:** simulate a `playerBetBatch` resolving across a `dealCards` (assert the bet is
either fully recorded+charged or fully rejected+not-charged, never charged-and-dropped);
regression test that `amount: 1.9` is rejected (previously charged 1, paid out on 1.9).

**DoD:** concurrency test green; fractional/oversized/unknown-spot batches rejected; manual
test of rapid-tap-into-deal shows no ticket discrepancy.

---

### Phase 2 — Wallet integrity *(high; money safety)*

| # | Item | Review | Approach |
|---|------|--------|----------|
| 2.1 | Atomic wallet mutations. | R⑩ | Replace `addTickets`/`removeTickets` read-modify-write with `User.findOneAndUpdate`: debit `{_id, ticketBalance:{$gte:qty}}` + `{$inc:{ticketBalance:-qty}, $push:{…}}` (null ⇒ insufficient funds); credit with `$inc:+qty`. Removes lost-update races and the same-user-in-two-games clobber without per-user locks. |
| 2.2 | Atomic wallet+bet. | R⑨, R⑱ | **Preferred:** wrap the debit and the `game.bets` update in `session.withTransaction` (requires replica set — see §3). **Fallback if no RS:** write `game.bets` first, debit last, and make every reversal save wrapped + retried; delete the fragile multi-catch compensation. |
| 2.3 | Move `transactions[]` off the hot user doc. | R⑪ | New `Transaction` collection keyed by `userId`; `insertOne` per event; keep only `ticketBalance` on `User`. Eliminates the unbounded-array read on every bet and the 16 MB ceiling. Include a one-time migration script under `scripts/`. |

**Tests:** concurrent payout-credit racing a bet-debit on the same user converges to the
correct balance; forced `game` write failure leaves wallet and bets consistent.

**DoD:** no code path mutates `ticketBalance` via full-document `save()`; balance integrity
test green; migration script verified against a copy of data.

---

### Phase 3 — Protocol hardening *(enables reliable client UI)*

Server changes that make Phase 4 possible and make the whole pipeline self-healing.

| # | Item | Review | Approach |
|---|------|--------|----------|
| 3.1 | Echo absolute totals, not deltas. | R④ | After commit, compute each affected spot's new total for the user and emit `{userId, spotId, total}`; client sets `chip.dataset.amount = total`. Lost/duplicate/reordered frames become self-correcting. |
| 3.2 | Include `spotId` in `betResults`. | R⑭ | Server adds the original `spotId` to each result entry. Client keys results off `spotId` directly and the ~90 lines of `betDescr`→`spotId` reconstruction (both copies) + duplicate `suitNameToSymbol` are deleted. `betDescr` stays for human display. |
| 3.3 | Idempotency + revision. | R⑨, R⑪-sync | `clientBatchId` (uuid) per `sendPendingBets`; server keeps a short-lived per-game processed-id set inside `runSerialized` and re-emits the prior confirmation on duplicates. Add monotonic `game.rev` so clients can detect gaps and resync. |
| 3.4 | Socket.IO acks. | R② | `socket.emit('playerBetBatch', payload, ack=>…)`; server calls back `{ok, bets:[{spotId,total}], balance, rev}` or `{ok:false, reason}`. |

**DoD:** dropping/duplicating an echo in a test still converges chip counts to server truth;
duplicate `clientBatchId` is charged once.

---

### Phase 4 — Client responsiveness *(high; fixes the *felt* bug)*

Depends on Phase 3 (absolute echoes + acks) for clean reconciliation.

| # | Item | Review | Approach |
|---|------|--------|----------|
| 4.1 | Optimistic chip rendering. | R⑤ | On tap, immediately render/increment a visually-distinct *pending* chip on the spot. On ack/echo mark confirmed and set to the server total; on `betError`/timeout roll back. Decouples feel from the 200 ms debounce + round-trip. |
| 4.2 | Pointer input + separated gestures. | R⑥, R⑦ | Placement on `pointerdown` (primary pointer; ignore synthetic mouse-after-touch). `.chip{pointer-events:none}` so taps always hit the spot (an ADD); move removal to an explicit affordance (corner "−" badge with `pointer-events:auto`, or a remove-mode toggle) so an add can never become a silent remove. |
| 4.3 | Per-tap acknowledgement. | R⑤-low | `-webkit-tap-highlight-color: transparent` + a brief `:active`/`spot-press` scale/brighten on the spot, independent of the network. |
| 4.4 | Reconnect & error resync. | R③, R⑩-sync | `socket.on('connect', ()=>socket.emit('requestGameData',{gameId}))`; on any `betError`, resync via the existing (idempotent) `rebuildUIFromState` and snap `displayedBalance = actualBalance` (respect the `isDealingPhase` gate so result animations aren't wiped). |
| 4.5 | LED from server truth. | R⑧-sync, R⑥-input | Keep `flashBetPlaced` as a transient flash only; reconcile `displayedBalance` to the server balance on every ack/`ticketUpdate`, and restore it on `betError`. |

**DoD:** on a throttled connection, rapid tapping shows a chip per tap instantly; a rejected
burst restores balance and explains why; backgrounding/reconnecting the PWA resyncs the board.

---

### Phase 5 — Structural refactor *(do last; largest diff, zero behavior change)*

| # | Item | Review | Approach |
|---|------|--------|----------|
| 5.1 | Split the 1974-line monolith into ES modules behind a thin entry, with shared state in a small object instead of ~21 bare globals: `spots`, `bets`, `cards`, `results`, `celebrate`, `ledBalance`, `audio`, `net`, `main`. | R⑮ | Mechanical move after behavior is settled, so big behavioral PRs aren't rebased over a file reshuffle. `gameBoard.ejs` already loads the script as `type="module"`. |

**DoD:** identical behavior; each module has a single clear responsibility; no cross-module
mutation of shared state except through the state object.

## 5. Sequencing rationale

- **0 before everything:** removing the dead single-bet protocol means Phases 1, 3, 4 only
  touch one path; the shared helpers/constants are edited by later phases anyway.
- **1 before 2:** the serialization/atomic-guard work in Phase 1 is the actual bug fix and is
  prerequisite context for the wallet atomicity decisions in Phase 2.
- **3 before 4:** optimistic UI can only reconcile cleanly against absolute, idempotent,
  acked messages.
- **5 last:** a pure structural move is lowest value and highest rebase-churn; settle behavior
  first.

If you want the **fastest path to relief** instead of the full program, the minimum that
resolves the reported bug is **Phase 1.1–1.2 + Phase 4.1 + 4.4** (stop real loss + optimistic
render + reconnect resync). Everything else is hardening and polish layered on top.

## 6. Risk register

| Risk | Phase | Mitigation |
|------|-------|------------|
| Removing "legacy" handlers breaks an unseen client | 0 | Verified only one client exists and it never emits the legacy events; grep gate in the PR. |
| Atomic wallet/bet needs replica set not yet provisioned | 2 | Decide infra up front; transaction-free fallback documented. |
| Absolute-echo protocol change desyncs mixed old/new clients during deploy | 3 | Single client, served from this app; deploy is atomic (no app-store lag). Still, gate behind `rev` so a stale client resyncs. |
| `transactions[]` migration data loss | 2 | Migration script run against a backup/copy first; keep the embedded array until the new collection is verified, then drop. |
| Module split introduces subtle load-order bugs | 5 | Done last with behavior frozen; rely on Phase 0's test scaffolding. |

## 7. Testing strategy

- Adopt `node --test` (no new deps). Priorities, in order of value:
  1. **Concurrency:** bet batch resolving across a deal/clear (Phase 1) — the core bug.
  2. **Exploit regression:** fractional/oversized/unknown-spot bets rejected (Phase 1).
  3. **Wallet integrity:** concurrent credit/debit on one user converges; partial-failure
     leaves no drift (Phase 2).
  4. **Idempotency:** duplicate `clientBatchId` charged once (Phase 3).
- Payout math in `srmPayoutService` is pure and table-testable — add unit tests for L/M/H tie
  cases and the joker-forces-loss rule while touching that file.
- Manual matrix for Phase 4 (real phone, throttled network): rapid tap, tap-into-deal,
  reject-on-closed, background/reconnect.

## 8. Rough effort

| Phase | Effort | Risk |
|-------|--------|------|
| 0 Foundations & dead code | S–M | Low |
| 1 Real bet loss & exploit | M | Med (concurrency) |
| 2 Wallet integrity | M–L | Med–High (infra + migration) |
| 3 Protocol hardening | M | Med |
| 4 Client responsiveness | M–L | Med (UX iteration) |
| 5 Module split | M | Low (mechanical) |
