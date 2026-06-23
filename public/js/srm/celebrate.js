/* srm/celebrate.js — the long-shot (Joker 26x / Ace 13x) celebration sequence (Phase 5).
 *
 * Full-screen banner, screen shake, confetti, audio, and card glow for a long-shot win, plus
 * teardown. Reads/writes only the shared `state` (longShotCelebrationActive flag, longShotAudio)
 * and the debug logger. */

import { state } from './state.js';
import { dbg } from './util.js';

/**
 * Check for longshot wins on a specific card and trigger celebration
 * @param {number} cardNumber - 1, 2, or 3
 * @param {Array} longShotWins - Array of longshot wins
 * @returns {Promise} - Resolves when celebration completes (or immediately if none)
 */
export async function checkAndTriggerCardLongshot(cardNumber, longShotWins) {
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
 * Trigger long shot celebration for Joker (26x) or Ace (13x) wins
 * @param {Array} longShotWins - Array of long shot win objects
 * @returns {Promise} - Resolves when celebration is complete
 */
export function triggerLongShotCelebration(longShotWins) {
  return new Promise((resolve) => {
    if (!longShotWins || longShotWins.length === 0) {
      resolve();
      return;
    }

    state.longShotCelebrationActive = true;

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
        state.longShotCelebrationActive = false;
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
    if (state.longShotAudio) {
      state.longShotAudio.currentTime = 0;
      state.longShotAudio.play().catch(err => {
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
export function cleanupCelebration() {
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
