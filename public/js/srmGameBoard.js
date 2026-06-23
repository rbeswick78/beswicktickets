let currentRoundStatus = 'betting';
let dealtCardsCache = null;     // Store dealt cards for results display

// Ticket update caching - prevent balance spoilers during card reveal
let ticketUpdateCache = [];     // Store ticket updates until cards finish flipping
let isDealingPhase = false;     // Track if we're in the card reveal animation

// Added audio variables
let placeYourBetsAudio;
let stealAudio;
let ryansAudio;
let moneyAudio;
let roundResultsAudio;
let longShotAudio;

// Long shot celebration state
let longShotWinsCache = null;
let longShotCelebrationActive = false;

// Progressive results state
let betResultsCache = null;  // Store all bet results for per-card reveal

// Chip selector state
let selectedBetAmount = 1; 

// LED Balance animation state
let displayedBalance = 0;        // What's currently shown on the LED
let actualBalance = 0;           // The real server balance
let balanceAnimationId = null;   // Animation frame ID for cleanup
let winTickAudio = null;         // Sound for count-up ticks

/**
 * A map to store userId -> color
 */
const userColorMap = {};
const socket = window.io();

// Debug logging — flip DEBUG to true to enable verbose console output.
const DEBUG = false;
function dbg(...args) { if (DEBUG) console.log(...args); }

// Animation/interaction timings (ms). CHIP_SETTLE_MS and CARD_FLIP_MS are coupled to
// srm.css (chipDrop 0.3s and the 0.8s card flip) — keep them in sync if the CSS changes.
const TIMING = {
  BATCH_MS: 200,
  CHIP_SETTLE_MS: 350,
  CARD_FLIP_MS: 800,
  ACK_TIMEOUT_MS: 4000, // how long to wait for a bet ack before rolling the optimistic chip back
};

// A pointer that moves more than this (px) before lift is treated as a scroll, not a tap, so the
// optimistic chip placed on pointerdown is rolled back (Phase 4.2). The board is taller than the
// viewport on mobile, so a vertical pan must never leave a stray bet behind.
const MOVE_CANCEL_PX = 12;

// Phase 4 optimistic-bet state. The reconciler (pure, unit-tested in test/srmBetReconciler.test.js)
// owns the current user's per-spot { confirmed, pending } and tells us what amount to render; the
// DOM glue below renders it. `lastAppliedRev` drives gap detection so a missed broadcast triggers a
// full resync. Loaded as a classic <script> before this module, so window.SrmBet is ready.
const { createBetReconciler, nextRevState, aggregateBatch } = window.SrmBet;
const reconciler = createBetReconciler();
let lastAppliedRev = null;

// Single source of truth: resolve a spotId to its bet-spot CSS class.
const SPOT_CLASS_RULES = [
  { test: (id) => id.includes('suits-'),                       cls: 'border-bet' },
  { test: (id) => id.includes('-odd') || id.includes('-even'), cls: 'odd-even-bet' },
  { test: (id) => id.includes('-joker'),                       cls: 'joker-bet' },
  { test: (id) => id.includes('-ace'),                         cls: 'ace-bet' },
  { test: (id) => id.includes('-low'),                         cls: 'lowest-bet' },
  { test: (id) => id.includes('-mid'),                         cls: 'middle-bet' },
  { test: (id) => id.includes('-high'),                        cls: 'highest-bet' },
];
function spotClass(spotId) {
  const rule = SPOT_CLASS_RULES.find((r) => r.test(spotId));
  return rule ? rule.cls : 'suit-quad';
}

/**
 * Helper to retrieve assigned color
 */
function getUserColor(userId) {
  return userColorMap[userId] || '#999';
}

/**
 * Helper function to determine the correct card image filename (SVG).
 */
function getCardImageSrc(card) {
  if (card.isJoker) {
    return '/svg/cards/1J.svg';
  }
  let rankCode = card.rank;
  if (rankCode === '10') rankCode = 'T'; // T for ten
  let suitCode;
  switch (card.suit) {
    case '♣': suitCode = 'C'; break;
    case '♦': suitCode = 'D'; break;
    case '♥': suitCode = 'H'; break;
    case '♠': suitCode = 'S'; break;
    default:
      suitCode = 'X'; // fallback if something unexpected
      break;
  }
  return `/svg/cards/${rankCode}${suitCode}.svg`;
}

/**
 * Show a toast notification
 * @param {string} message 
 * @param {string} type 'error' | 'success' | 'info'
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s forwards';
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}

/**
 * -------------------------------------------------------------
 *  LED Balance Animation Logic
 * -------------------------------------------------------------
 */

/**
 * Update the LED display with optional animation
 * @param {number} newBalance - The new balance to display
 * @param {boolean} animate - Whether to animate the transition
 * @param {boolean} isWin - Whether this is a win (triggers count-up with sound)
 */
function updateLedBalance(newBalance, animate = false, isWin = false) {
  const ledContainer = document.querySelector('.balance-led');
  const ledDisplay = document.getElementById('my-balance-amount');
  
  if (!ledDisplay || !ledContainer) return;
  
  actualBalance = newBalance;
  
  if (!animate || displayedBalance === newBalance) {
    // Instant update
    displayedBalance = newBalance;
    ledDisplay.textContent = newBalance.toLocaleString();
    return;
  }
  
  // Cancel any running animation
  if (balanceAnimationId) {
    cancelAnimationFrame(balanceAnimationId);
    balanceAnimationId = null;
  }
  
  const startValue = displayedBalance;
  const endValue = newBalance;
  const diff = endValue - startValue;
  
  if (diff === 0) return;
  
  if (isWin && diff > 0) {
    // Count up one by one for wins
    animateCountUp(startValue, endValue, ledDisplay, ledContainer);
  } else if (diff < 0) {
    // Loss or bet - show red flash and instant update
    ledContainer.classList.add('loss-flash');
    displayedBalance = endValue;
    ledDisplay.textContent = endValue.toLocaleString();
    setTimeout(() => {
      ledContainer.classList.remove('loss-flash');
    }, 500);
  } else {
    // Generic increase without win animation
    displayedBalance = endValue;
    ledDisplay.textContent = endValue.toLocaleString();
  }
}

/**
 * Animate counting up one by one with sound
 */
function animateCountUp(startValue, endValue, ledDisplay, ledContainer) {
  const diff = endValue - startValue;
  
  // Calculate timing: aim for 2-3 seconds max, minimum 30ms per tick
  const maxDuration = 3000;
  const minInterval = 30;
  let interval = Math.max(minInterval, Math.floor(maxDuration / diff));
  
  // Cap at reasonable speed for large wins
  if (interval < minInterval) interval = minInterval;
  
  ledContainer.classList.add('counting-up');
  
  let currentValue = startValue;
  
  function tick() {
    currentValue++;
    displayedBalance = currentValue;
    ledDisplay.textContent = currentValue.toLocaleString();
    
    // Play tick sound (with slight pitch variation for interest)
    if (winTickAudio) {
      const tickSound = winTickAudio.cloneNode();
      tickSound.volume = 0.3;
      tickSound.playbackRate = 0.9 + Math.random() * 0.2; // Slight variation
      tickSound.play().catch(() => {});
    }
    
    if (currentValue < endValue) {
      balanceAnimationId = setTimeout(tick, interval);
    } else {
      // Animation complete
      ledContainer.classList.remove('counting-up');
      balanceAnimationId = null;
    }
  }
  
  tick();
}

/**
 * Flash the LED for bet placement (instant, optimistic decrement). This is a *transient* feel-good
 * flash only (Phase 4.5): the authoritative balance is reconciled to the server's value on every
 * bet ack and ticketUpdate, and restored from it on a rejection. `actualBalance` (server truth) is
 * never touched here, so a wrong optimistic decrement is always recoverable.
 * @param {number} betAmount - Amount being bet
 */
function flashBetPlaced(betAmount) {
  const ledContainer = document.querySelector('.balance-led');
  const ledDisplay = document.getElementById('my-balance-amount');

  if (!ledDisplay || !ledContainer) return;

  // Instantly decrement displayed balance
  displayedBalance = Math.max(0, displayedBalance - betAmount);
  ledDisplay.textContent = displayedBalance.toLocaleString();

  // Add red flash class
  ledContainer.classList.add('bet-placed');
  setTimeout(() => {
    ledContainer.classList.remove('bet-placed');
  }, 300);
}

/**
 * Reverse a single optimistic flashBetPlaced decrement (used when a tap is reclassified as a scroll
 * and undone before it is sent). Re-adds the amount to the displayed balance only.
 */
function unflashBet(betAmount) {
  const ledDisplay = document.getElementById('my-balance-amount');
  displayedBalance += betAmount;
  if (ledDisplay) ledDisplay.textContent = displayedBalance.toLocaleString();
}

/**
 * Snap the LED back to the authoritative server balance (Phase 4.5). Called on a bet rejection so
 * an optimistic decrement that the server refused is undone immediately.
 */
function restoreLedBalance() {
  const ledDisplay = document.getElementById('my-balance-amount');
  displayedBalance = actualBalance;
  if (ledDisplay) ledDisplay.textContent = actualBalance.toLocaleString();
}

/**
 * -------------------------------------------------------------
 *  Batch Betting Logic (Global Scope)
 * -------------------------------------------------------------
 */
let pendingBets = [];
let batchTimer = null;

// Stable id per batch so the server can dedupe a retried send (Phase 3.3 idempotency). uuid where
// available (secure contexts), with a best-effort fallback so non-secure dev origins still work.
function makeBatchId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sendPendingBets() {
  batchTimer = null;
  if (pendingBets.length === 0) return;

  // Aggregate the queued taps into one net delta per spot (zero-net spots dropped). `batchDeltas`
  // is the exact per-spot deltas this batch carries, used to reconcile its pending on ack (Phase
  // 4.1) — we reconcile by the deltas we SENT, not the server's confirmed delta, so an optimistic
  // removal the server ignored is still cleared (see srmBetReconciler.js).
  const taps = pendingBets;
  pendingBets = [];
  const { finalBets, deltas: batchDeltas } = aggregateBatch(taps);

  // Ensure we have gameId/userId from window (set in DOMContentLoaded)
  const gId = window.gameId;
  const uId = window.currentUserId;

  if (finalBets.length === 0 || !gId || !uId) return;

  const batchGeneration = reconciler.getGeneration();

  let settled = false;
  let timeoutId = null;
  const finish = () => { settled = true; if (timeoutId) clearTimeout(timeoutId); };

  // Success: subtract this batch's deltas from pending and SET confirmed from the absolute totals,
  // then reconcile the LED to the server balance. A resync (generation bump) that landed while we
  // waited makes this ack stale — discard it; the resync already pulled absolute truth.
  const onSuccess = (ack) => {
    if (settled) return;
    finish();
    if (batchGeneration !== reconciler.getGeneration()) return;
    const affected = reconciler.confirm(batchDeltas, Array.isArray(ack.bets) ? ack.bets : []);
    affected.forEach(renderMyChip);
    if (typeof ack.balance === 'number') updateLedBalance(ack.balance, false);
  };

  // Failure / timeout: roll the optimistic deltas back (confirmed untouched) and restore the LED.
  // A {ok:false} rejection also raises a betError, which drives the toast + full resync; a silent
  // timeout has no betError, so we resync here to re-pull absolute truth.
  const onFailure = (isTimeout) => {
    if (settled) return;
    finish();
    if (batchGeneration !== reconciler.getGeneration()) return;
    const affected = reconciler.rollback(batchDeltas);
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
function queueBet(spotId, amount) {
  pendingBets.push({ spotId, amount });
  if (!batchTimer) {
    batchTimer = setTimeout(sendPendingBets, TIMING.BATCH_MS);
  }
}

/**
 * Render an optimistic tap immediately (Phase 4.1): bump the reconciler's pending, draw the chip as
 * "unconfirmed", and flash the LED. This is the INSTANT half — it does NOT send anything. The
 * network commit is deferred to queueBet so a gesture that turns into a scroll can be reverted
 * before anything reaches the server (Phase 4.2). `amount` is positive to add, negative to remove.
 */
function applyOptimisticTap(spotId, amount) {
  reconciler.tap(spotId, amount);
  renderMyChip(spotId);
  if (amount > 0) flashBetPlaced(amount);
}

/** Reverse an optimistic tap that was never committed (a tap reclassified as a scroll). */
function revertOptimisticTap(spotId, amount) {
  reconciler.tap(spotId, -amount);
  renderMyChip(spotId);
  if (amount > 0) unflashBet(amount);
}

/**
 * Place a bet immediately — render optimistically AND queue the network batch in one step. Used for
 * discrete, deliberate actions that aren't part of a press-and-maybe-scroll gesture: the chip remove
 * badge and the no-PointerEvent click fallback.
 */
function placeBet(spotId, amount) {
  if (currentRoundStatus !== 'betting') return;
  applyOptimisticTap(spotId, amount);
  queueBet(spotId, amount);
}

/** Ask the server for the authoritative game state; the gameData handler rebuilds from it. */
function resyncGameData() {
  const gId = window.gameId;
  if (gId) socket.emit('requestGameData', { gameId: gId });
}

// Track an incoming rev; on a detected gap (a missed broadcast) pull a full resync (Phase 4.4).
function noteRevWithGap(rev) {
  const res = nextRevState(lastAppliedRev, rev);
  lastAppliedRev = res.lastRev;
  if (res.gap) resyncGameData();
}

// Reset the rev baseline from an authoritative full-state message (gameData / roundCleared).
function resetRev(rev) {
  if (typeof rev === 'number') lastAppliedRev = rev;
}

// Set a spot's chip to the server's ABSOLUTE per-user total (Phase 3.1). Because the server
// echoes the new total (not a delta), the client SETS rather than adds — so a lost, duplicated,
// or reordered frame is self-correcting. total <= 0 means the user has no stake left here.
// Used for OTHER players' chips; the current user's chip goes through renderMyChip (optimistic).
function setChipUI(userId, spotId, total) {
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
function renderMyChip(spotId, settled) {
  const targetEl = getBetSpotElement(spotId);
  if (!targetEl) return;
  const total = reconciler.displayAmount(spotId);
  const existingChip = targetEl.querySelector(`.chip[data-user-id="${currentUserId}"]`);

  if (total <= 0) {
    if (existingChip) existingChip.remove();
    positionChips(targetEl);
    return;
  }

  let chipEl = existingChip;
  if (!chipEl) {
    chipEl = createChipElement(currentUserId, total, spotId);
    targetEl.appendChild(chipEl);
  } else {
    setChipAmount(chipEl, total);
  }
  chipEl.classList.toggle('chip-unconfirmed', reconciler.isPending(spotId));
  if (settled) chipEl.classList.add('chip-settled');
  positionChips(targetEl);
}

/**
 * Set a chip's displayed amount via a dedicated `.chip-amount` child (created on first use) so the
 * value can be updated without clobbering sibling elements such as the remove badge.
 */
function setChipAmount(chipEl, amount) {
  chipEl.dataset.amount = amount;
  let amtEl = chipEl.querySelector('.chip-amount');
  if (!amtEl) {
    amtEl = document.createElement('span');
    amtEl.className = 'chip-amount';
    chipEl.insertBefore(amtEl, chipEl.firstChild);
  }
  amtEl.textContent = amount;
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
    placeBet(spotId, -selectedBetAmount);
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
function createChipElement(userId, amount, spotId) {
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

  if (userId === currentUserId) addRemoveBadge(chipEl, spotId);
  return chipEl;
}

/**
 * Preload a card image and return a promise that resolves when loaded
 */
function preloadCardImage(card) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.src);
    img.onerror = () => resolve(getCardImageSrc(card)); // Resolve anyway on error
    img.src = getCardImageSrc(card);
  });
}

/**
 * Preload ALL card SVGs on page load for instant responsiveness
 */
function preloadAllCardImages() {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const suits = ['C', 'D', 'H', 'S'];
  const cardPaths = [];
  
  // Add all regular cards
  for (const rank of ranks) {
    for (const suit of suits) {
      cardPaths.push(`/svg/cards/${rank}${suit}.svg`);
    }
  }
  
  // Add jokers
  cardPaths.push('/svg/cards/1J.svg');
  cardPaths.push('/svg/cards/2J.svg');
  
  // Add card backs
  cardPaths.push('/svg/cards/1B.svg');
  cardPaths.push('/svg/cards/2B.svg');
  
  // Preload all images (non-blocking)
  cardPaths.forEach(path => {
    const img = new Image();
    img.src = path;
  });
  
  dbg(`[preloadAllCardImages] Preloading ${cardPaths.length} card images`);
}

// Preload all cards immediately when script loads
preloadAllCardImages();

/**
 * Reveal a single card's image in the specified DOM slot using 3D flip
 * @returns {Promise} - Resolves when the flip animation has started
 */
function revealCard(slotEl, card, altText) {
  return new Promise((resolve) => {
    // Find the inner container for the flip
    const cardInner = slotEl.querySelector('.card-inner');
    // Find the back face image (which will be revealed)
    const faceImg = slotEl.querySelector('.card-back img');
    
    if (cardInner && faceImg) {
      faceImg.src = getCardImageSrc(card);
      faceImg.alt = altText;
      
      // Wait for image to be decoded/rendered before flipping to avoid white flash
      if (faceImg.decode) {
        faceImg.decode().then(() => {
          cardInner.classList.add('flipped');
          resolve(); // Flip has started
        }).catch(() => {
          // Fallback: flip anyway if decode fails
          cardInner.classList.add('flipped');
          resolve();
        });
      } else {
        // Fallback for browsers without decode support
        faceImg.onload = () => {
          cardInner.classList.add('flipped');
          resolve();
        };
        // If already loaded (cached), flip immediately
        if (faceImg.complete) {
          cardInner.classList.add('flipped');
          resolve();
        }
      }
    } else {
      resolve(); // Nothing to flip, resolve anyway
    }
  });
}

/**
 * Reset a card slot to face down
 */
function resetCard(slotEl) {
    const cardInner = slotEl.querySelector('.card-inner');
    if (cardInner) {
        cardInner.classList.remove('flipped');
        // Optional: clear the src after animation to avoid flashing old card on next flip
        setTimeout(() => {
            const faceImg = slotEl.querySelector('.card-back img');
            if(faceImg) faceImg.src = '';
        }, 800);
    }
}

/**
 * Helper: Promise-based delay
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper: Get the DOM element for a bet spot
 */
function getBetSpotElement(spotId) {
  return document.querySelector(`.${spotClass(spotId)}[data-spot-id="${spotId}"]`);
}

/**
 * Build a unique bet key from userId and spotId for grouping
 */
function getBetKey(userId, spotId) {
  return `${userId}-${spotId}`;
}

/**
 * Show bet results for a specific card with chip animations
 * @param {number} cardNumber - 1, 2, or 3
 * @param {Array} allBetResults - All bet results from the server
 * @returns {Promise} - Resolves when animations complete
 */
async function showCardBetResults(cardNumber, allBetResults) {
  // Filter bet results for this card (handle both string and number cardNumber)
  const cardNumStr = String(cardNumber);
  const cardBets = allBetResults.filter(bet => String(bet.cardNumber) === cardNumStr);
  
  
  if (cardBets.length === 0) {
    return; // No bets for this card
  }

  // Get all chips on this card's betting container
  const bettingContainer = document.getElementById(`betting-container-${cardNumber}`);
  if (!bettingContainer) {
    console.warn(`[showCardBetResults] Betting container not found for card ${cardNumber}`);
    return;
  }

  const allChips = bettingContainer.querySelectorAll('.chip');

  // Key results directly off the server-provided spotId (Phase 3.2). This replaces the old
  // betDescr->spotId reconstruction (and its duplicate suitNameToSymbol): the chip's data-spot-id
  // and the result's spotId are now the same string, so the match is exact.
  const betLookup = {};
  cardBets.forEach(bet => {
    const key = `${bet.userId}:${bet.spotId}`;
    if (!betLookup[key]) {
      betLookup[key] = { net: 0, wager: 0 };
    }
    betLookup[key].net += bet.net;
    betLookup[key].wager += bet.wager;
  });

  // Helper to check if a spotId is an L/M/H bet
  function isLMHBet(spotId) {
    return spotId.endsWith('-low') || spotId.endsWith('-mid') || spotId.endsWith('-high');
  }

  // Now process each chip
  const animationPromises = [];
  
  allChips.forEach(chip => {
    const chipSpotId = chip.dataset.spotId;
    const chipUserId = chip.dataset.userId;
    
    if (!chipSpotId || !chipSpotId.startsWith(`card${cardNumber}-`)) {
      return; // Not for this card
    }
    
    // Check if this is an L/M/H bet - ALWAYS defer to resolveLMHBets()
    // L/M/H outcomes depend on ALL 3 cards, so we show pending state until card 3 is revealed
    if (isLMHBet(chipSpotId)) {
      // Only add pending if not already pending (for cards 1 & 2, pending was already added)
      if (!chip.classList.contains('pending')) {
        chip.classList.add('pending');
        dbg(`[showCardBetResults] L/M/H bet set to pending for card ${cardNumber}: ${chipSpotId}`);
      }
      
      // Short animation promise for pending state
      const animPromise = new Promise(resolve => {
        setTimeout(resolve, 400);
      });
      animationPromises.push(animPromise);
      return; // Skip normal win/lose processing - resolveLMHBets() will handle it
    }
    
    const lookupKey = `${chipUserId}:${chipSpotId}`;
    dbg(`[showCardBetResults] Looking up chip with key: ${lookupKey}`);
    const result = betLookup[lookupKey];
    
    if (!result) {
      console.warn(`[showCardBetResults] No result found for chip key: ${lookupKey}`);
      return;
    }
    
    dbg(`[showCardBetResults] Found result for chip:`, result);
    
    const spotEl = chip.parentElement;
    
    // Apply win/lose effects to chips (no badges displayed)
    if (result.net > 0) {
      // WIN - apply winning shimmer effect
      chip.classList.add('winning');
      if (spotEl) spotEl.classList.add('spot-win');
    } else if (result.net < 0) {
      // LOSS - apply cracked/broken effect (chip stays visible)
      chip.classList.add('losing');
      if (spotEl) spotEl.classList.add('spot-loss');
    }
    // PUSH (net = 0) - no visual effect applied
    
    // Track animation completion
    const animPromise = new Promise(resolve => {
      setTimeout(resolve, result.net >= 0 ? 1200 : 800);
    });
    animationPromises.push(animPromise);
  });

  // Wait for all animations to complete (or at least give some time for visual effect)
  if (animationPromises.length > 0) {
    await Promise.all(animationPromises);
  }
  
  // Small extra delay for visual clarity
  await delay(300);
}

/**
 * Resolve all pending L/M/H bets after all 3 cards have been revealed
 * This creates a dramatic "moment of truth" where all L/M/H chips resolve simultaneously
 * @param {Array} allBetResults - All bet results from the server
 * @returns {Promise} - Resolves when all L/M/H animations complete
 */
async function resolveLMHBets(allBetResults) {
  // Find all chips with pending state (L/M/H bets waiting for resolution)
  const pendingChips = document.querySelectorAll('.chip.pending');
  
  if (pendingChips.length === 0) {
    dbg('[resolveLMHBets] No pending L/M/H bets to resolve');
    return;
  }
  
  dbg(`[resolveLMHBets] Resolving ${pendingChips.length} pending L/M/H bets`);
  
  // Build lookup keyed directly off the server-provided spotId (Phase 3.2) — same exact match the
  // chips use, no betDescr reconstruction.
  const betLookup = {};
  allBetResults.forEach(bet => {
    const key = `${bet.userId}:${bet.spotId}`;
    if (!betLookup[key]) {
      betLookup[key] = { net: 0, wager: 0 };
    }
    betLookup[key].net += bet.net;
    betLookup[key].wager += bet.wager;
  });
  
  // Process each pending chip with staggered timing for dramatic effect
  const animationPromises = [];
  let staggerIndex = 0;
  
  pendingChips.forEach(chip => {
    const chipSpotId = chip.dataset.spotId;
    const chipUserId = chip.dataset.userId;
    const lookupKey = `${chipUserId}:${chipSpotId}`;
    const result = betLookup[lookupKey];
    
    if (!result) {
      console.warn(`[resolveLMHBets] No result found for pending chip: ${lookupKey}`);
      chip.classList.remove('pending');
      return;
    }
    
    const spotEl = chip.parentElement;
    const staggerDelay = staggerIndex * 100; // 100ms stagger between chips
    staggerIndex++;
    
    const animPromise = new Promise(resolve => {
      setTimeout(() => {
        // Remove pending state
        chip.classList.remove('pending');
        
        // Apply final result state
        if (result.net > 0) {
          // WIN
          chip.classList.add('winning');
          if (spotEl) spotEl.classList.add('spot-win');
          dbg(`[resolveLMHBets] L/M/H WIN: ${chipSpotId} net=${result.net}`);
        } else if (result.net < 0) {
          // LOSS
          chip.classList.add('losing');
          if (spotEl) spotEl.classList.add('spot-loss');
          dbg(`[resolveLMHBets] L/M/H LOSS: ${chipSpotId} net=${result.net}`);
        } else {
          // PUSH (net = 0) - tie or joker dealt
          chip.classList.add('push');
          dbg(`[resolveLMHBets] L/M/H PUSH: ${chipSpotId} net=${result.net}`);
        }
        
        // Resolve after animation completes
        setTimeout(resolve, result.net > 0 ? 1000 : 600);
      }, staggerDelay);
    });
    
    animationPromises.push(animPromise);
  });
  
  // Wait for all animations
  if (animationPromises.length > 0) {
    await Promise.all(animationPromises);
  }
  
  // Extra delay for visual clarity
  await delay(300);
  
  dbg('[resolveLMHBets] All L/M/H bets resolved');
}

/**
 * Check for longshot wins on a specific card and trigger celebration
 * @param {number} cardNumber - 1, 2, or 3
 * @param {Array} longShotWins - Array of longshot wins
 * @returns {Promise} - Resolves when celebration completes (or immediately if none)
 */
async function checkAndTriggerCardLongshot(cardNumber, longShotWins) {
  if (!longShotWins || longShotWins.length === 0) {
    return;
  }
  
  // Filter for longshots on this specific card (handle both string and number)
  const cardNumInt = parseInt(cardNumber, 10);
  const cardLongshots = longShotWins.filter(ls => parseInt(ls.cardNumber, 10) === cardNumInt);
  
  if (cardLongshots.length > 0) {
    dbg(`[checkAndTriggerCardLongshot] Card ${cardNumber} has longshot wins:`, cardLongshots);
    await triggerLongShotCelebration(cardLongshots);
  }
}

/**
 * Show the inline summary panel with round results
 * @param {Array} betResults - All bet results 
 */
function showSummaryPanel(betResults) {
  // Aggregate results by player
  const playerTotals = {};
  let totalPot = 0;
  let biggestWin = 0;
  let biggestLoss = 0;

  betResults.forEach((result) => {
    const { userId, username, wager, net } = result;
    totalPot += wager;

    if (!playerTotals[userId]) {
      playerTotals[userId] = {
        userId,
        username,
        totalWager: 0,
        totalNet: 0,
        bets: []
      };
    }
    playerTotals[userId].totalWager += wager;
    playerTotals[userId].totalNet += net;
    playerTotals[userId].bets.push(result);

    if (net > biggestWin) biggestWin = net;
    if (net < biggestLoss) biggestLoss = net;
  });

  // Convert to array and sort by net result (highest first)
  const sortedPlayers = Object.values(playerTotals).sort((a, b) => b.totalNet - a.totalNet);

  // Get current user's total net
  const myData = playerTotals[currentUserId];
  const myNet = myData ? myData.totalNet : 0;

  // Small helpers shared by both summary panels
  const netModifier = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral');
  const signed = (n) => (n > 0 ? '+' : '') + n;

  // Render standings + your-net + stats into one panel (desktop or mobile).
  const renderSummaryInto = (cfg) => {
    const yourNetEl = document.getElementById(cfg.yourNetId);
    if (yourNetEl) {
      yourNetEl.textContent = signed(myNet);
      yourNetEl.className = cfg.yourValueClass;
      if (myNet > 0) yourNetEl.classList.add('positive');
      else if (myNet < 0) yourNetEl.classList.add('negative');
    }

    const standingsEl = document.getElementById(cfg.standingsId);
    if (standingsEl) {
      standingsEl.innerHTML = '';
      sortedPlayers.forEach((player) => {
        const el = document.createElement('div');
        el.className = cfg.rowClass;
        if (player.userId === currentUserId) el.classList.add('is-you');
        el.innerHTML = `
        <${cfg.tag} class="${cfg.nameClass}" style="color: ${getUserColor(player.userId)}">${player.username}</${cfg.tag}>
        <${cfg.tag} class="${cfg.netElClass} ${netModifier(player.totalNet)}">${signed(player.totalNet)}</${cfg.tag}>
      `;
        standingsEl.appendChild(el);
      });
    }

    const potEl = document.getElementById(cfg.potId);
    if (potEl) potEl.textContent = totalPot;
    const bestEl = document.getElementById(cfg.bestId);
    if (bestEl) bestEl.textContent = biggestWin > 0 ? `+${biggestWin}` : '0';
    const worstEl = document.getElementById(cfg.worstId);
    if (worstEl) worstEl.textContent = biggestLoss < 0 ? biggestLoss : '0';
  };

  // Desktop panel (referenced again below to toggle visibility).
  const summaryPanel = document.getElementById('summary-panel');
  renderSummaryInto({
    yourNetId: 'summary-your-net', yourValueClass: 'summary-your-value',
    standingsId: 'summary-standings', rowClass: 'summary-player-row', tag: 'span',
    nameClass: 'summary-player-name', netElClass: 'summary-player-net',
    potId: 'summary-total-pot', bestId: 'summary-biggest-win', worstId: 'summary-biggest-loss',
  });

  // Mobile panel.
  renderSummaryInto({
    yourNetId: 'summary-mobile-your-net', yourValueClass: 'summary-mobile-your-value',
    standingsId: 'summary-mobile-standings', rowClass: 'summary-mobile-player', tag: 'div',
    nameClass: 'summary-mobile-player-name', netElClass: 'summary-mobile-player-net',
    potId: 'summary-mobile-pot', bestId: 'summary-mobile-best', worstId: 'summary-mobile-worst',
  });

  // Show the panels with animation
  if (summaryPanel) summaryPanel.classList.add('visible');
  const summaryPanelMobile = document.getElementById('summary-panel-mobile');
  if (summaryPanelMobile) summaryPanelMobile.classList.add('visible');

  // Trigger toast for winners
  if (myNet > 0) {
    showToast(`You won ${myNet} tickets!`, 'success');
  }

  // Play round results audio
  if (roundResultsAudio) {
    roundResultsAudio.play().catch(err => {
      console.warn('Audio play failed for round-results.mp3:', err);
    });
  }
}

/**
 * Hide the summary panels
 */
function hideSummaryPanels() {
  const summaryPanel = document.getElementById('summary-panel');
  const summaryPanelMobile = document.getElementById('summary-panel-mobile');
  
  if (summaryPanel) summaryPanel.classList.remove('visible');
  if (summaryPanelMobile) summaryPanelMobile.classList.remove('visible', 'minimized');
}

/**
 * Clear all bet result animations and badges
 */
function clearBetResultAnimations() {
  // Remove all result badges
  document.querySelectorAll('.bet-result-badge').forEach(badge => badge.remove());
  
  // Remove animation classes from chips (including pending and push states)
  document.querySelectorAll('.chip.winning, .chip.losing, .chip.pending, .chip.push').forEach(chip => {
    chip.classList.remove('winning', 'losing', 'pending', 'push');
  });
  
  // Remove spot highlight classes
  document.querySelectorAll('.spot-win, .spot-loss').forEach(spot => {
    spot.classList.remove('spot-win', 'spot-loss');
  });
}

/**
 * Trigger long shot celebration for Joker (26x) or Ace (13x) wins
 * @param {Array} longShotWins - Array of long shot win objects
 * @returns {Promise} - Resolves when celebration is complete
 */
function triggerLongShotCelebration(longShotWins) {
  return new Promise((resolve) => {
    if (!longShotWins || longShotWins.length === 0) {
      resolve();
      return;
    }

    longShotCelebrationActive = true;

    // Create overlay if it doesn't exist
    let overlay = document.getElementById('longshot-celebration-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'longshot-celebration-overlay';
      overlay.className = 'longshot-celebration-overlay';
      document.body.appendChild(overlay);
    }

    // Create confetti container
    let confettiContainer = document.getElementById('longshot-confetti-container');
    if (!confettiContainer) {
      confettiContainer = document.createElement('div');
      confettiContainer.id = 'longshot-confetti-container';
      confettiContainer.className = 'longshot-confetti-container';
      document.body.appendChild(confettiContainer);
    }

    // Celebrate each long shot win sequentially
    let currentIndex = 0;
    const celebrationDuration = 5000; // 5 seconds per celebration

    function celebrateNext() {
      if (currentIndex >= longShotWins.length) {
        // All celebrations complete
        cleanupCelebration();
        longShotCelebrationActive = false;
        resolve();
        return;
      }

      const win = longShotWins[currentIndex];
      showSingleLongShotCelebration(win, overlay, confettiContainer);
      currentIndex++;

      // Schedule next celebration or cleanup
      setTimeout(celebrateNext, celebrationDuration);
    }

    celebrateNext();
  });
}

/**
 * Display celebration for a single long shot win
 */
function showSingleLongShotCelebration(win, overlay, confettiContainer) {
  const isJoker = win.type === 'joker';
  const typeLabel = isJoker ? 'JOKER!' : 'ACE!';
  const titleClass = isJoker ? 'longshot-title joker-win' : 'longshot-title';

  // Build overlay content
  overlay.innerHTML = `
    <div class="longshot-rays"></div>
    <div class="longshot-spotlight"></div>
    <div class="longshot-banner">
      <div class="longshot-type">${typeLabel}</div>
      <div class="${titleClass}">LONG SHOT WIN!</div>
      <div class="longshot-winner-name" style="color: ${win.winnerColor}">${win.winnerName}</div>
      <div class="longshot-payout">
        +${win.payout} tickets
        <span class="longshot-multiplier">${win.multiplier}x</span>
      </div>
    </div>
  `;

  // Show overlay with animation
  setTimeout(() => {
    overlay.classList.add('active');
    
    // Add screen shake
    document.body.classList.add('screen-shake');
    setTimeout(() => {
      document.body.classList.remove('screen-shake');
    }, 600);
  }, 0);

  // Show banner
  setTimeout(() => {
    const banner = overlay.querySelector('.longshot-banner');
    if (banner) banner.classList.add('visible');
  }, 200);

  // Trigger enhanced confetti
  setTimeout(() => {
    triggerLongShotConfetti(confettiContainer, isJoker);
  }, 500);

  // Play celebration audio
  setTimeout(() => {
    if (longShotAudio) {
      longShotAudio.currentTime = 0;
      longShotAudio.play().catch(err => {
        console.warn('Audio play failed for longshot celebration:', err);
      });
    }
  }, 700);

  // Add glow to winning card
  setTimeout(() => {
    const cardSlot = document.getElementById(`card-slot-${win.cardNumber}`);
    if (cardSlot) {
      cardSlot.classList.add('longshot-glow');
      if (isJoker) {
        cardSlot.classList.add('joker-glow');
      }
    }
  }, 1000);

  // Begin fade out
  setTimeout(() => {
    overlay.classList.remove('active');
    const banner = overlay.querySelector('.longshot-banner');
    if (banner) banner.classList.remove('visible');
  }, 4000);
}

/**
 * Trigger enhanced confetti for long shot wins
 */
function triggerLongShotConfetti(container, isJoker) {
  container.innerHTML = '';

  const colors = isJoker 
    ? ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#f472b6', '#a855f7'] // Rainbow for joker
    : ['#ffd700', '#ffec8b', '#daa520', '#f4d03f', '#fff8dc', '#d4af37']; // Gold for ace

  const shapes = ['star', 'circle', 'diamond'];
  const confettiCount = 100;

  for (let i = 0; i < confettiCount; i++) {
    const confetti = document.createElement('div');
    const shape = shapes[Math.floor(Math.random() * shapes.length)];
    confetti.className = `longshot-confetti ${shape}`;
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 1 + 's';
    confetti.style.animationDuration = (3 + Math.random() * 2) + 's';
    
    container.appendChild(confetti);
    
    // Trigger animation
    setTimeout(() => {
      confetti.classList.add('active');
    }, 50);
  }

  // Clean up after animation
  setTimeout(() => {
    container.innerHTML = '';
  }, 6000);
}

/**
 * Clean up celebration elements
 */
function cleanupCelebration() {
  const overlay = document.getElementById('longshot-celebration-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.innerHTML = '';
  }

  const confettiContainer = document.getElementById('longshot-confetti-container');
  if (confettiContainer) {
    confettiContainer.innerHTML = '';
  }

  // Remove card glow effects
  document.querySelectorAll('.card-slot').forEach(slot => {
    slot.classList.remove('longshot-glow', 'joker-glow');
  });
}

/**
 * Rebuild UI from server state without revealing cards instantly if resultsPending
 */
function rebuildUIFromState(gameState, currentUserId, isDealer) {
  const { roundStatus, bets } = gameState;

  // 1) Clear existing chips
  document.querySelectorAll('.chip').forEach(chip => chip.remove());

  // 2) Reset the optimistic state to absolute server truth. resyncFrom seeds the current user's
  //    confirmed stakes, drops any unreconciled pending, and bumps the generation so an in-flight
  //    batch ack from before this resync is discarded rather than applied against the new baseline.
  //    Taps queued but not yet sent are dropped too — the server view we just pulled is canonical.
  const myConfirmed = (bets || [])
    .filter((b) => String(b.userId) === String(currentUserId))
    .map((b) => ({ spotId: b.spotId, total: b.amount }));
  reconciler.resyncFrom(myConfirmed);
  pendingBets = [];
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

  // 3) We avoid automatically revealing all three cards if roundStatus === 'resultsPending'.
  //    Instead, rely on timed reveal in socket.on('cardsDealt').

  // 4) Render current bets as chips. Each game.bets entry is the ABSOLUTE per-(user,spot) stake, so
  //    we SET (the current user via the reconciler, others directly) — never accumulate.
  if (bets && bets.length > 0) {
    bets.forEach((bet) => {
      const { userId, spotId, amount } = bet;
      if (String(userId) === String(currentUserId)) {
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
  if ((roundStatus === 'results' || roundStatus === 'resultsPending') && isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton && !dealButton.classList.contains('dealing')) {
      dealButton.textContent = 'Clear';
    }
  }
}

/**
 * Position chips in a grid using percentage offsets
 */
function positionChips(parentEl) {
  const chipEls = Array.from(parentEl.querySelectorAll('.chip'));
  
  // We want to fit up to 9 chips nicely in a 3x3 grid, 
  // and then start stacking/overlapping if there are more.
  
  chipEls.forEach((chip, index) => {
    // 3x3 grid logic
    // 0 | 1 | 2
    // ---------
    // 3 | 4 | 5
    // ---------
    // 6 | 7 | 8
    
    // For 10+, we cycle or just stack. Let's stack cyclically.
    const gridPos = index % 9;
    
    const col = gridPos % 3; 
    const row = Math.floor(gridPos / 3);
    
    // Base offsets (in %)
    // Cell is 100% x 100%. Chip is roughly 33% x 33% (2.4em in 8em cell ~= 30%)
    
    let leftPct = col * 33.3;
    let topPct = row * 33.3;
    
    // Add a little randomness or stack offset for >9
    const stackLayer = Math.floor(index / 9);
    if (stackLayer > 0) {
        // Shift slightly to show stack
        leftPct += stackLayer * 2; 
        topPct -= stackLayer * 2;
    }
    
    // Apply
    chip.style.left = leftPct + '%';
    chip.style.top = topPct + '%';
    
    // Important: We need to override the physical pixel/em size if we want pure % scaling
    // BUT we set chip size in em in CSS. So it scales with the board.
    // So we just need to place the top-left corner correctly.
  });
}

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
  const bodyEl = document.querySelector('body');
  window.gameId = bodyEl.getAttribute('data-game-id');
  window.currentUserId = bodyEl.getAttribute('data-current-user-id');
  const dealerId = bodyEl.getAttribute('data-dealer-id');
  window.isDealer = (currentUserId === dealerId);

  const dealButton = document.getElementById('deal-button');
  const cardSlot1 = document.getElementById('card-slot-1');
  const cardSlot2 = document.getElementById('card-slot-2');
  const cardSlot3 = document.getElementById('card-slot-3');
  const balanceList = document.getElementById('balance-list');
  const myBalanceDisplay = document.getElementById('my-balance-amount');

  // -------------------------------------------------------------
  //  HUD / Sidebar Logic
  // -------------------------------------------------------------
  const hudToggle = document.getElementById('hud-toggle');
  const hudClose = document.getElementById('hud-close');
  const sidebar = document.getElementById('player-sidebar');

  if (hudToggle && sidebar) {
      // Open the sidebar by default and hide the toggle button
      sidebar.classList.add('open');
      hudToggle.style.display = 'none';
      
      hudToggle.addEventListener('click', () => {
          sidebar.classList.add('open');
          hudToggle.style.display = 'none';
      });
  }

  if (hudClose && sidebar) {
      hudClose.addEventListener('click', () => {
          sidebar.classList.remove('open');
          hudToggle.style.display = '';
      });
  }

  // -------------------------------------------------------------
  //  Chip Selector Logic
  // -------------------------------------------------------------
  const chipOptions = document.querySelectorAll('.chip-option');
  const bettingContainers = document.querySelectorAll('.betting-container');
  
  /**
   * Update the cursor class on all betting containers based on selected chip
   */
  function updateChipCursor(value) {
    bettingContainers.forEach(container => {
      // Remove all cursor classes
      container.classList.remove('chip-cursor-1', 'chip-cursor-5', 'chip-cursor-10', 'chip-cursor-20', 'chip-cursor-50');
      // Add the new cursor class
      container.classList.add(`chip-cursor-${value}`);
    });
  }
  
  // Initialize cursor with default chip
  updateChipCursor(1);
  
  // Handle chip selection
  chipOptions.forEach(chip => {
    chip.addEventListener('click', () => {
      // Update selected state
      chipOptions.forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      
      // Update bet amount
      selectedBetAmount = parseInt(chip.dataset.value, 10);
      
      // Update cursor
      updateChipCursor(selectedBetAmount);
    });
  });

  // -------------------------------------------------------------
  //  Mobile Summary Panel Toggle
  // -------------------------------------------------------------
  const mobileHandle = document.getElementById('summary-mobile-handle');
  const mobileSummaryPanel = document.getElementById('summary-panel-mobile');
  
  if (mobileHandle && mobileSummaryPanel) {
    mobileHandle.addEventListener('click', () => {
      // Toggle between visible and minimized states
      if (mobileSummaryPanel.classList.contains('visible')) {
        if (mobileSummaryPanel.classList.contains('minimized')) {
          mobileSummaryPanel.classList.remove('minimized');
        } else {
          mobileSummaryPanel.classList.add('minimized');
        }
      }
    });
  }

  // -------------------------------------------------------------
  //  Initialize and load audio files
  // -------------------------------------------------------------
  placeYourBetsAudio = new Audio('/sound/place-your-bets.mp3');
  placeYourBetsAudio.load();

  stealAudio = new Audio('/sound/steal.mp3');
  stealAudio.load();

  ryansAudio = new Audio('/sound/ryans.mp3');
  ryansAudio.load();

  moneyAudio = new Audio('/sound/money.mp3');
  moneyAudio.load();

  roundResultsAudio = new Audio('/sound/round-results.mp3'); 
  roundResultsAudio.load();

  longShotAudio = new Audio('/sound/beswick-boys-rule.mp3');
  longShotAudio.load();
  
  winTickAudio = new Audio('/sound/win-single.mp3');
  winTickAudio.load();

  // Helper for updating or creating a new player-balance item
  function updatePlayerBalance(userId, username, balance) {
    let balanceItem = document.getElementById(`balance-${userId}`);
    if (!balanceItem) {
      balanceItem = document.createElement('div');
      balanceItem.id = `balance-${userId}`;
      balanceItem.className = `balance-item${userId === currentUserId ? ' current-user' : ''}`;
      balanceList.appendChild(balanceItem);
    }
    // Update color just in case
    balanceItem.style.color = getUserColor(userId);
    balanceItem.textContent = `${username}: ${balance}`;

    // Update the LED balance display for current user
    if (userId === currentUserId && myBalanceDisplay) {
      // Determine if this is a win (balance increased from server perspective)
      // and we're in results phase (cards have been dealt)
      const isWin = balance > actualBalance && (currentRoundStatus === 'resultsPending' || currentRoundStatus === 'results');
      
      // Animate if balance changed and we have a prior value
      const shouldAnimate = actualBalance !== 0 && balance !== actualBalance;
      
      updateLedBalance(balance, shouldAnimate, isWin);
    }
  }

  // Join Socket.IO room for this game
  socket.emit('joinGameRoom', { gameId, userId: currentUserId });
  socket.emit('requestGameData', { gameId });

  // On receiving the entire game data
  socket.on('gameData', (data) => {
    data.players.forEach((player) => {
      userColorMap[player.userId] = player.color;
      
      // During dealing phase, cache balance updates to prevent spoilers
      if (isDealingPhase) {
        ticketUpdateCache.push({
          userId: player.userId,
          username: player.username,
          ticketBalance: player.ticketBalance
        });
      } else {
        // Initialize LED balance for current user (no animation on load)
        if (player.userId === currentUserId) {
          displayedBalance = player.ticketBalance;
          actualBalance = player.ticketBalance;
        }
        
        updatePlayerBalance(player.userId, player.username, player.ticketBalance);
      }
    });
    
    // gameData is the authoritative full-state snapshot — reset the rev baseline from it (Phase
    // 4.4) so subsequent betPlacedBatch echoes are gap-checked against a known-good revision.
    resetRev(data.rev);

    // Don't rebuild UI during dealing phase - it would wipe out winning/losing chip effects.
    // Outside dealing, also sync the local betting gate so a player who loaded/resynced mid-results
    // can't place optimistic bets the server would only reject.
    if (!isDealingPhase) {
      if (typeof data.roundStatus === 'string') currentRoundStatus = data.roundStatus;
      rebuildUIFromState(data, currentUserId, isDealer);
    }
  });

  // Reconnect resync (Phase 4.4): a dropped-then-restored socket is a fresh connection that is no
  // longer in the game room, so re-join and pull absolute truth. rebuildUIFromState (via gameData)
  // is idempotent and resets the optimistic state, so any bets lost across the gap self-heal.
  socket.on('connect', () => {
    const gId = window.gameId;
    if (!gId) return;
    socket.emit('joinGameRoom', { gameId: gId, userId: window.currentUserId });
    socket.emit('requestGameData', { gameId: gId });
  });

  // Listen for colorAssignment
  socket.on('colorAssignment', (data) => {
    const { userId, color } = data;
    userColorMap[userId] = color;
  });

  // Listen for playerList
  socket.emit('requestPlayers', { gameId });
  socket.on('playerList', (players) => {
    players.forEach((player) => {
      userColorMap[player.userId] = player.color;
      
      // Initialize LED balance for current user if not already set
      if (player.userId === currentUserId && actualBalance === 0) {
        displayedBalance = player.ticketBalance;
        actualBalance = player.ticketBalance;
      }
      
      updatePlayerBalance(player.userId, player.username, player.ticketBalance);
    });
  });

  // Listen for ticketUpdate - cache during dealing to prevent balance spoilers
  socket.on('ticketUpdate', (data) => {
    if (isDealingPhase) {
      // Cache the update until cards finish flipping
      ticketUpdateCache.push(data);
    } else {
      updatePlayerBalance(data.userId, data.username, data.ticketBalance);
    }
  });

  // cardsDealt => do a time-staggered reveal with progressive results
  socket.on('cardsDealt', async (dealData) => {
    dbg('[cardsDealt] arrived, starting progressive reveal sequence');

    // Enter dealing phase - cache any ticketUpdate events until cards finish flipping
    isDealingPhase = true;

    // Cache the dealt cards for results display
    dealtCardsCache = {
      card1: dealData.card1,
      card2: dealData.card2,
      card3: dealData.card3
    };

    // Cards are already preloaded on page load, start flip sequence immediately
    dbg('[cardsDealt] starting progressive flip sequence');

    // Title word elements for highlight animation
    const titleSteal = document.getElementById('title-steal');
    const titleRyans = document.getElementById('title-ryans');
    const titleMoney = document.getElementById('title-money');

    currentRoundStatus = 'resultsPending';

    // Helper to wait for bet results if not yet available
    async function waitForBetResults(maxWait = 5000) {
      const startTime = Date.now();
      while (!betResultsCache && (Date.now() - startTime) < maxWait) {
        await delay(100);
      }
      return betResultsCache;
    }

    // ===== CARD 1 =====
    dbg('[cardsDealt] Revealing Card 1');
    stealAudio.play().catch(err => {
      console.warn('Audio play failed for steal.mp3:', err);
    });
    if (titleSteal) titleSteal.classList.add('highlight');
    
    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot1, dealData.card1, 'Card 1');
    await delay(TIMING.CARD_FLIP_MS); // Wait for flip animation (0.8s CSS transition)
    
    // Show bet results for card 1 (if we have them)
    let betResults = betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(1, betResults);
      // Check for longshot on card 1
      await checkAndTriggerCardLongshot(1, longShotWinsCache);
    }
    
    // Remove highlight from "Steal"
    if (titleSteal) titleSteal.classList.remove('highlight');
    
    // Delay before next card
    await delay(1500);

    // ===== CARD 2 =====
    dbg('[cardsDealt] Revealing Card 2');
    ryansAudio.play().catch(err => {
      console.warn('Audio play failed for ryans.mp3:', err);
    });
    if (titleRyans) titleRyans.classList.add('highlight');
    
    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot2, dealData.card2, 'Card 2');
    await delay(TIMING.CARD_FLIP_MS);
    
    // Show bet results for card 2
    betResults = betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(2, betResults);
      // Check for longshot on card 2
      await checkAndTriggerCardLongshot(2, longShotWinsCache);
    }
    
    // Remove highlight from "Ryan's"
    if (titleRyans) titleRyans.classList.remove('highlight');
    
    // Delay before next card
    await delay(1500);

    // ===== CARD 3 =====
    dbg('[cardsDealt] Revealing Card 3');
    moneyAudio.play().catch(err => {
      console.warn('Audio play failed for money.mp3:', err);
    });
    if (titleMoney) titleMoney.classList.add('highlight');
    
    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot3, dealData.card3, 'Card 3');
    await delay(TIMING.CARD_FLIP_MS);
    
    // Show bet results for card 3
    betResults = betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(3, betResults);
      // Check for longshot on card 3
      await checkAndTriggerCardLongshot(3, longShotWinsCache);
      
      // ===== L/M/H RESOLUTION =====
      // Now that all 3 cards are revealed, resolve all pending L/M/H bets
      // This creates a dramatic "moment of truth" where all L/M/H chips resolve simultaneously
      await delay(500); // Brief pause before the big reveal
      await resolveLMHBets(betResults);
    }
    
    // Remove highlight from "Money"
    if (titleMoney) titleMoney.classList.remove('highlight');

    // Apply cached ticket updates now that all cards are revealed
    ticketUpdateCache.forEach(data => {
      updatePlayerBalance(data.userId, data.username, data.ticketBalance);
    });
    ticketUpdateCache = [];
    isDealingPhase = false;

    // Show summary panel after a brief delay
    await delay(1000);
    
    if (betResults) {
      showSummaryPanel(betResults);
    }
    
    // Clear longshot cache
    longShotWinsCache = null;

    // Switch dealer button from "Dealing" to "Clear" after results are shown
    if (dealButton) {
      dealButton.textContent = 'Clear';
      dealButton.classList.remove('dealing');
    }
    
    dbg('[cardsDealt] Progressive reveal sequence complete');
  });

  // longShotWins => cache for per-card celebrations
  socket.on('longShotWins', (longShotWins) => {
    dbg('[longShotWins] event arrived:', longShotWins);
    longShotWinsCache = longShotWins;
  });

  // payouts => cache for progressive reveal (cardsDealt handles the display)
  socket.on('payoutResults', (betResults) => {
    dbg('[payoutResults] event arrived, caching for progressive reveal');
    // Store in betResultsCache for the progressive reveal sequence to use
    betResultsCache = betResults;
    
  });


  // Place bets. On pointerdown the chip renders optimistically at once (the felt-responsiveness fix)
  // but the network commit is DEFERRED to pointerup (Phase 4.2): a press that then moves past
  // MOVE_CANCEL_PX, or that the browser reclassifies via pointercancel, is a scroll — its optimistic
  // chip is reverted and nothing is ever sent, so a pan on the taller-than-viewport mobile felt can
  // never leave a stray, charged bet. Deferring the send (not the render) is what closes the race
  // the 200 ms batch timer would otherwise win. Multiple concurrent pointers are tracked by id so a
  // two-thumb rapid tapper has every tap register. Falls back to click where PointerEvent is absent.
  const bettableAreas = document.querySelectorAll(
    '.suit-quad, .border-bet, .odd-even-bet, .joker-bet, .ace-bet, .lowest-bet, .middle-bet, .highest-bet'
  );

  // pointerId -> { spotId, x, y, amount } for gestures whose tap-vs-scroll is not yet resolved.
  const activePointers = new Map();

  function pressFeedback(area) {
    area.classList.add('spot-press'); // Phase 4.3: brief, network-independent tap acknowledgement
    setTimeout(() => area.classList.remove('spot-press'), 150);
  }

  function beginPlacement(area, e) {
    if (currentRoundStatus !== 'betting') return;
    const spotId = area.getAttribute('data-spot-id');
    if (!spotId) return;
    pressFeedback(area);
    activePointers.set(e.pointerId, { spotId, x: e.clientX, y: e.clientY, amount: selectedBetAmount });
    applyOptimisticTap(spotId, selectedBetAmount); // render now; the network send waits for pointerup
  }

  bettableAreas.forEach((area) => {
    if (window.PointerEvent) {
      area.addEventListener('pointerdown', (e) => beginPlacement(area, e));
    } else {
      area.addEventListener('click', () => {
        if (currentRoundStatus !== 'betting') return;
        const spotId = area.getAttribute('data-spot-id');
        if (spotId) placeBet(spotId, selectedBetAmount);
      });
    }
  });

  if (window.PointerEvent) {
    // Document-level so a pan that drifts off the original spot is still caught. Passive: we never
    // preventDefault here — that would block the page from scrolling.
    document.addEventListener('pointermove', (e) => {
      const p = activePointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
        activePointers.delete(e.pointerId);
        revertOptimisticTap(p.spotId, p.amount); // scroll: undo the optimistic chip; nothing was sent
      }
    }, { passive: true });
    document.addEventListener('pointerup', (e) => {
      const p = activePointers.get(e.pointerId);
      if (!p) return;
      activePointers.delete(e.pointerId);
      queueBet(p.spotId, p.amount); // confirmed a tap → commit the network batch
    });
    document.addEventListener('pointercancel', (e) => {
      const p = activePointers.get(e.pointerId);
      if (!p) return;
      activePointers.delete(e.pointerId);
      revertOptimisticTap(p.spotId, p.amount); // browser took over (scroll/system) → undo
    });
  }

  // Listen for betPlacedBatch — each entry is an ABSOLUTE per-spot total (Phase 3.1), so we SET.
  // The current user's own entries feed the reconciler's `confirmed` (the ack always arrives first
  // on the same connection and has already cleared the matching pending, so this is idempotent);
  // other players' entries set their chips directly. The batch's rev drives gap detection.
  socket.on('betPlacedBatch', (data) => {
    if (!data) return;
    // A duplicate-clientBatchId replay re-emits an OLD confirmation (older absolute totals AND an
    // older rev). Don't let such a stale frame lower our own confirmed below the truth a newer
    // batch already set — the rev guard would then suppress the heal. The generation-guarded ack is
    // authoritative for our stake; fresh echoes (rev > lastAppliedRev) still apply normally.
    const staleForMe =
      typeof data.rev === 'number' && lastAppliedRev != null && data.rev <= lastAppliedRev;
    if (Array.isArray(data.bets)) {
      data.bets.forEach(bet => {
        if (String(bet.userId) === String(currentUserId)) {
          if (!staleForMe) {
            reconciler.setConfirmed(bet.spotId, bet.total);
            renderMyChip(bet.spotId);
          }
        } else {
          setChipUI(bet.userId, bet.spotId, bet.total);
        }
      });
    }
    noteRevWithGap(data.rev);
  });

  // Deal or Clear
  // Note: dealButton might be null if not dealer
  if (dealButton) {
    dealButton.addEventListener('click', () => {
      if (dealButton.textContent === 'Deal') {

        // Switch to "Dealing" state
        dealButton.textContent = 'Dealing';
        dealButton.classList.add('dealing');

        socket.emit('dealCards', { gameId, userId: currentUserId });
      } else if (dealButton.textContent === 'Clear') {
        socket.emit('clearRound', { gameId, userId: currentUserId });
      }
      // If "Dealing", ignore clicks (button is disabled via CSS)
    });
  }

  // roundCleared => UI reset
  socket.on('roundCleared', (data) => {
    // Clear all bet result animations and badges first
    clearBetResultAnimations();

    // Remove all chips
    document.querySelectorAll('.chip').forEach(chip => chip.remove());

    // Reset the optimistic bet state to empty (the round cleared every bet), drop any queued/
    // in-flight taps, and re-baseline rev from the cleared revision (Phase 4.4).
    reconciler.resyncFrom([]);
    pendingBets = [];
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    resetRev(data && data.rev);

    // Hide summary panels
    hideSummaryPanels();

    if (isDealer && dealButton) {
      dealButton.textContent = 'Deal';
      dealButton.classList.remove('dealing');
    }
    currentRoundStatus = 'betting';

    // Reset cards to face down (flip back)
    resetCard(cardSlot1);
    resetCard(cardSlot2);
    resetCard(cardSlot3);

    // Play "place-your-bets" audio when the round is cleared
    if (placeYourBetsAudio) {
      placeYourBetsAudio.play().catch(err => {
        console.warn('Audio play failed:', err);
      });
    }

    // Reset flags for all clients
    betResultsCache = null;  // Also clear the new cache
    dealtCardsCache = null;
    longShotWinsCache = null;
    longShotCelebrationActive = false;
    ticketUpdateCache = [];
    isDealingPhase = false;
    
    // Sync displayed balance with actual (in case of any drift)
    displayedBalance = actualBalance;
    const ledDisplay = document.getElementById('my-balance-amount');
    if (ledDisplay) {
      ledDisplay.textContent = actualBalance.toLocaleString();
    }

    // Clean up any leftover celebration elements
    cleanupCelebration();
  });

  // betError => toast + restore the optimistic LED to server truth (Phase 4.4/4.5). We deliberately
  // DON'T pull a full resync here: every bet rejection also fires the ack {ok:false}, whose handler
  // already did the precise per-batch rollback, and a betError with no ack (a dealer-only-action
  // error) doesn't touch our bets at all. A full requestGameData -> rebuildUIFromState would wipe
  // and redraw EVERY chip on the board on a routine insufficient-funds over-tap (a jarring flicker)
  // for no convergence benefit. True desync is covered by reconnect, rev-gap, and ack-timeout.
  socket.on('betError', (data) => {
    showToast(data.message, 'error');
    restoreLedBalance();
  });
});
