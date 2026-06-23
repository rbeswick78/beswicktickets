/* srm/ledBalance.js — the LED "Bank" balance display & its animations (Phase 5).
 *
 * Owns the optimistic-decrement flash, the count-up win animation, and the reconcile-to-server
 * snapback. Reads/writes only the shared `state` (displayedBalance / actualBalance /
 * balanceAnimationId / winTickAudio); never touches bets or board modules. */

import { state } from './state.js';

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
export function updateLedBalance(newBalance, animate = false, isWin = false) {
  const ledContainer = document.querySelector('.balance-led');
  const ledDisplay = document.getElementById('my-balance-amount');

  if (!ledDisplay || !ledContainer) return;

  state.actualBalance = newBalance;

  if (!animate || state.displayedBalance === newBalance) {
    // Instant update
    state.displayedBalance = newBalance;
    ledDisplay.textContent = newBalance.toLocaleString();
    return;
  }

  // Cancel any running animation
  if (state.balanceAnimationId) {
    cancelAnimationFrame(state.balanceAnimationId);
    state.balanceAnimationId = null;
  }

  const startValue = state.displayedBalance;
  const endValue = newBalance;
  const diff = endValue - startValue;

  if (diff === 0) return;

  if (isWin && diff > 0) {
    // Count up one by one for wins
    animateCountUp(startValue, endValue, ledDisplay, ledContainer);
  } else if (diff < 0) {
    // Loss or bet - show red flash and instant update
    ledContainer.classList.add('loss-flash');
    state.displayedBalance = endValue;
    ledDisplay.textContent = endValue.toLocaleString();
    setTimeout(() => {
      ledContainer.classList.remove('loss-flash');
    }, 500);
  } else {
    // Generic increase without win animation
    state.displayedBalance = endValue;
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
    state.displayedBalance = currentValue;
    ledDisplay.textContent = currentValue.toLocaleString();

    // Play tick sound (with slight pitch variation for interest)
    if (state.winTickAudio) {
      const tickSound = state.winTickAudio.cloneNode();
      tickSound.volume = 0.3;
      tickSound.playbackRate = 0.9 + Math.random() * 0.2; // Slight variation
      tickSound.play().catch(() => {});
    }

    if (currentValue < endValue) {
      state.balanceAnimationId = setTimeout(tick, interval);
    } else {
      // Animation complete
      ledContainer.classList.remove('counting-up');
      state.balanceAnimationId = null;
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
export function flashBetPlaced(betAmount) {
  const ledContainer = document.querySelector('.balance-led');
  const ledDisplay = document.getElementById('my-balance-amount');

  if (!ledDisplay || !ledContainer) return;

  // Instantly decrement displayed balance
  state.displayedBalance = Math.max(0, state.displayedBalance - betAmount);
  ledDisplay.textContent = state.displayedBalance.toLocaleString();

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
export function unflashBet(betAmount) {
  const ledDisplay = document.getElementById('my-balance-amount');
  state.displayedBalance += betAmount;
  if (ledDisplay) ledDisplay.textContent = state.displayedBalance.toLocaleString();
}

/**
 * Snap the LED back to the authoritative server balance (Phase 4.5). Called on a bet rejection so
 * an optimistic decrement that the server refused is undone immediately.
 */
export function restoreLedBalance() {
  const ledDisplay = document.getElementById('my-balance-amount');
  state.displayedBalance = state.actualBalance;
  if (ledDisplay) ledDisplay.textContent = state.actualBalance.toLocaleString();
}
