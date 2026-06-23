/* srm/bets.js — chips + optimistic bets + the network batch/ack (Phase 5).
 *
 * The coupled core of the felt: chip rendering (the current user's via the reconciler, others'
 * directly), the optimistic tap/revert lifecycle, the 200 ms batch + Socket.IO ack reconciliation,
 * rev-gap resync, and the full-state rebuild. Chip creation and bet placement are intrinsically
 * recursive (a chip carries a remove badge that places a bet), so they live in ONE module; that
 * keeps the import graph acyclic — only the entry imports this module, and it imports only
 * downward (state, board, ledBalance, util, constants). */

import { state, socket, nextRevState, aggregateBatch } from './state.js';
import { TIMING } from './constants.js';
import { getBetSpotElement, positionChips, getUserColor, setChipAmount } from './board.js';
import { flashBetPlaced, unflashBet, restoreLedBalance, updateLedBalance } from './ledBalance.js';
import { showToast, makeBatchId } from './util.js';

/**
 * -------------------------------------------------------------
 *  Batch Betting Logic
 * -------------------------------------------------------------
 */

export function sendPendingBets() {
  state.batchTimer = null;
  if (state.pendingBets.length === 0) return;

  // Aggregate the queued taps into one net delta per spot (zero-net spots dropped). `batchDeltas`
  // is the exact per-spot deltas this batch carries, used to reconcile its pending on ack (Phase
  // 4.1) — we reconcile by the deltas we SENT, not the server's confirmed delta, so an optimistic
  // removal the server ignored is still cleared (see srmBetReconciler.js).
  const taps = state.pendingBets;
  state.pendingBets = [];
  const { finalBets, deltas: batchDeltas } = aggregateBatch(taps);

  // Ensure we have gameId/userId from the shared state (set in DOMContentLoaded)
  const gId = state.gameId;
  const uId = state.currentUserId;

  if (finalBets.length === 0 || !gId || !uId) return;

  const batchGeneration = state.reconciler.getGeneration();

  let settled = false;
  let timeoutId = null;
  const finish = () => { settled = true; if (timeoutId) clearTimeout(timeoutId); };

  // Success: subtract this batch's deltas from pending and SET confirmed from the absolute totals,
  // then reconcile the LED to the server balance. A resync (generation bump) that landed while we
  // waited makes this ack stale — discard it; the resync already pulled absolute truth.
  const onSuccess = (ack) => {
    if (settled) return;
    finish();
    if (batchGeneration !== state.reconciler.getGeneration()) return;
    const affected = state.reconciler.confirm(batchDeltas, Array.isArray(ack.bets) ? ack.bets : []);
    affected.forEach(renderMyChip);
    if (typeof ack.balance === 'number') updateLedBalance(ack.balance, false);
  };

  // Failure / timeout: roll the optimistic deltas back (confirmed untouched) and restore the LED.
  // A {ok:false} rejection also raises a betError, which drives the toast + full resync; a silent
  // timeout has no betError, so we resync here to re-pull absolute truth.
  const onFailure = (isTimeout) => {
    if (settled) return;
    finish();
    if (batchGeneration !== state.reconciler.getGeneration()) return;
    const affected = state.reconciler.rollback(batchDeltas);
    affected.forEach(renderMyChip);
    restoreLedBalance();
    if (isTimeout) {
      showToast('Bet timed out — resyncing.', 'error');
      resyncGameData();
    }
  };

  timeoutId = setTimeout(() => onFailure(true), TIMING.ACK_TIMEOUT_MS);

  socket.emit(
    'playerBetBatch',
    { gameId: gId, userId: uId, bets: finalBets, clientBatchId: makeBatchId() },
    // Ack (Phase 3.4): {ok, bets:[{spotId,total}], balance, rev} or {ok:false, reason}.
    (ack) => {
      if (ack && ack.ok) onSuccess(ack);
      else onFailure(false);
    }
  );
}

// Queue a bet delta for the next 200 ms batch. Optimistic rendering + the LED flash happen in
// applyOptimisticTap; this only manages the network batch (Phase 4.1 decouples feel from this
// debounce + round-trip). For gesture taps, queueBet is called on pointerup once the press is
// confirmed a tap (not a scroll); the remove badge / click fallback call it via placeBet.
export function queueBet(spotId, amount) {
  state.pendingBets.push({ spotId, amount });
  if (!state.batchTimer) {
    state.batchTimer = setTimeout(sendPendingBets, TIMING.BATCH_MS);
  }
}

/**
 * Render an optimistic tap immediately (Phase 4.1): bump the reconciler's pending, draw the chip as
 * "unconfirmed", and flash the LED. This is the INSTANT half — it does NOT send anything. The
 * network commit is deferred to queueBet so a gesture that turns into a scroll can be reverted
 * before anything reaches the server (Phase 4.2). `amount` is positive to add, negative to remove.
 */
export function applyOptimisticTap(spotId, amount) {
  state.reconciler.tap(spotId, amount);
  renderMyChip(spotId);
  if (amount > 0) flashBetPlaced(amount);
}

/** Reverse an optimistic tap that was never committed (a tap reclassified as a scroll). */
export function revertOptimisticTap(spotId, amount) {
  state.reconciler.tap(spotId, -amount);
  renderMyChip(spotId);
  if (amount > 0) unflashBet(amount);
}

/**
 * Place a bet immediately — render optimistically AND queue the network batch in one step. Used for
 * discrete, deliberate actions that aren't part of a press-and-maybe-scroll gesture: the chip remove
 * badge and the no-PointerEvent click fallback.
 */
export function placeBet(spotId, amount) {
  if (state.currentRoundStatus !== 'betting') return;
  applyOptimisticTap(spotId, amount);
  queueBet(spotId, amount);
}

/** Ask the server for the authoritative game state; the gameData handler rebuilds from it. */
export function resyncGameData() {
  const gId = state.gameId;
  if (gId) socket.emit('requestGameData', { gameId: gId });
}

// Track an incoming rev; on a detected gap (a missed broadcast) pull a full resync (Phase 4.4).
export function noteRevWithGap(rev) {
  const res = nextRevState(state.lastAppliedRev, rev);
  state.lastAppliedRev = res.lastRev;
  if (res.gap) resyncGameData();
}

// Reset the rev baseline from an authoritative full-state message (gameData / roundCleared).
export function resetRev(rev) {
  if (typeof rev === 'number') state.lastAppliedRev = rev;
}

// Set a spot's chip to the server's ABSOLUTE per-user total (Phase 3.1). Because the server
// echoes the new total (not a delta), the client SETS rather than adds — so a lost, duplicated,
// or reordered frame is self-correcting. total <= 0 means the user has no stake left here.
// Used for OTHER players' chips; the current user's chip goes through renderMyChip (optimistic).
export function setChipUI(userId, spotId, total) {
  const targetEl = getBetSpotElement(spotId);

  if (!targetEl) return;
  const existingChip = targetEl.querySelector(`.chip[data-user-id="${userId}"]`);
  if (total <= 0) {
    if (existingChip) existingChip.remove();
  } else if (existingChip) {
    setChipAmount(existingChip, total);
  } else {
    const chipEl = createChipElement(userId, total, spotId);
    targetEl.appendChild(chipEl);
  }
  positionChips(targetEl);
}

/**
 * Render the CURRENT USER's chip on a spot from the reconciler's absolute display amount (Phase
 * 4.1). Adds the `.chip-unconfirmed` class while the spot carries an unreconciled optimistic delta.
 * @param {string} spotId
 * @param {boolean} [settled] - skip the drop-in animation (used during a full rebuild)
 */
export function renderMyChip(spotId, settled) {
  const targetEl = getBetSpotElement(spotId);
  if (!targetEl) return;
  const total = state.reconciler.displayAmount(spotId);
  const existingChip = targetEl.querySelector(`.chip[data-user-id="${state.currentUserId}"]`);

  if (total <= 0) {
    if (existingChip) existingChip.remove();
    positionChips(targetEl);
    return;
  }

  let chipEl = existingChip;
  if (!chipEl) {
    chipEl = createChipElement(state.currentUserId, total, spotId);
    targetEl.appendChild(chipEl);
  } else {
    setChipAmount(chipEl, total);
  }
  chipEl.classList.toggle('chip-unconfirmed', state.reconciler.isPending(spotId));
  if (settled) chipEl.classList.add('chip-settled');
  positionChips(targetEl);
}

/**
 * Attach an explicit remove affordance (corner "−" badge) to the current user's chip (Phase 4.2).
 * The chip itself is `pointer-events:none` so a tap on it falls through to the spot (an ADD); only
 * this badge re-enables pointer events, so an add can never silently become a remove. The badge
 * fires on pointerdown and stops propagation so the underlying spot does not also register an add.
 */
function addRemoveBadge(chipEl, spotId) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'chip-remove-badge';
  badge.setAttribute('aria-label', 'Remove a chip from this spot');
  badge.textContent = '−';
  const onRemove = (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    placeBet(spotId, -state.selectedBetAmount);
  };
  if (window.PointerEvent) badge.addEventListener('pointerdown', onRemove);
  else badge.addEventListener('click', onRemove);
  chipEl.appendChild(badge);
}

/**
 * Create a chip element. The amount lives in a `.chip-amount` child; the current user's chip also
 * gets a remove badge. Removal is the badge's job only (Phase 4.2) — the chip body no longer
 * carries a click-to-remove listener, so a tap on a chip is always an add on the spot beneath it.
 */
export function createChipElement(userId, amount, spotId) {
  const chipEl = document.createElement('div');
  chipEl.classList.add('chip');
  chipEl.dataset.userId = userId;
  chipEl.dataset.spotId = spotId;
  chipEl.style.color = getUserColor(userId); // Use currentColor in CSS
  setChipAmount(chipEl, amount);

  // Mark chip as settled after drop animation completes to prevent re-animation
  setTimeout(() => {
    chipEl.classList.add('chip-settled');
  }, TIMING.CHIP_SETTLE_MS); // matches srm.css chipDrop (0.3s)

  if (userId === state.currentUserId) addRemoveBadge(chipEl, spotId);
  return chipEl;
}

/**
 * Rebuild UI from server state without revealing cards instantly if resultsPending
 */
export function rebuildUIFromState(gameState) {
  const { roundStatus, bets } = gameState;

  // 1) Clear existing chips
  document.querySelectorAll('.chip').forEach(chip => chip.remove());

  // 2) Reset the optimistic state to absolute server truth. resyncFrom seeds the current user's
  //    confirmed stakes, drops any unreconciled pending, and bumps the generation so an in-flight
  //    batch ack from before this resync is discarded rather than applied against the new baseline.
  //    Taps queued but not yet sent are dropped too — the server view we just pulled is canonical.
  const myConfirmed = (bets || [])
    .filter((b) => String(b.userId) === String(state.currentUserId))
    .map((b) => ({ spotId: b.spotId, total: b.amount }));
  state.reconciler.resyncFrom(myConfirmed);
  state.pendingBets = [];
  if (state.batchTimer) { clearTimeout(state.batchTimer); state.batchTimer = null; }

  // 3) We avoid automatically revealing all three cards if roundStatus === 'resultsPending'.
  //    Instead, rely on timed reveal in socket.on('cardsDealt').

  // 4) Render current bets as chips. Each game.bets entry is the ABSOLUTE per-(user,spot) stake, so
  //    we SET (the current user via the reconciler, others directly) — never accumulate.
  if (bets && bets.length > 0) {
    bets.forEach((bet) => {
      const { userId, spotId, amount } = bet;
      if (String(userId) === String(state.currentUserId)) {
        renderMyChip(spotId, true); // settled: no drop-in animation on rebuild
        return;
      }
      const targetEl = getBetSpotElement(spotId);
      if (!targetEl) return;
      const chipEl = createChipElement(userId, amount, spotId);
      chipEl.classList.add('chip-settled'); // settled immediately during rebuild
      targetEl.appendChild(chipEl);
      positionChips(targetEl);
    });
  }

  // 5) If roundStatus is 'results' or 'resultsPending' and this user is dealer, show 'Clear'.
  //    But don't override if currently in "dealing" animation state
  if ((roundStatus === 'results' || roundStatus === 'resultsPending') && state.isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton && !dealButton.classList.contains('dealing')) {
      dealButton.textContent = 'Clear';
    }
  }
}
