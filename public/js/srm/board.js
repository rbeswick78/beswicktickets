/* srm/board.js — board geometry & low-level chip DOM for the SRM game board (Phase 5).
 *
 * Resolves a spotId to its DOM element / CSS class, positions chips within a spot, looks up a
 * player's colour, and sets a chip's displayed amount. These are leaf rendering helpers: they read
 * the shared `state` (for the colour map) but never call into higher-level feature modules, so the
 * import graph stays acyclic (board <- bets/results, never the reverse). */

import { state } from './state.js';

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

export function spotClass(spotId) {
  const rule = SPOT_CLASS_RULES.find((r) => r.test(spotId));
  return rule ? rule.cls : 'suit-quad';
}

/**
 * Helper to retrieve assigned color
 */
export function getUserColor(userId) {
  return state.userColorMap[userId] || '#999';
}

/**
 * Helper: Get the DOM element for a bet spot
 */
export function getBetSpotElement(spotId) {
  return document.querySelector(`.${spotClass(spotId)}[data-spot-id="${spotId}"]`);
}

/**
 * Set a chip's displayed amount via a dedicated `.chip-amount` child (created on first use) so the
 * value can be updated without clobbering sibling elements such as the remove badge.
 */
export function setChipAmount(chipEl, amount) {
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
 * Position chips in a grid using percentage offsets
 */
export function positionChips(parentEl) {
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
