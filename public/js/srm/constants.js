/* srm/constants.js — immutable timing/interaction constants for the SRM game board (Phase 5).
 *
 * These were bare module-level `const`s in the monolith; they are pure values with no state, so
 * they live in their own leaf module that imports nothing. */

// Animation/interaction timings (ms). CHIP_SETTLE_MS and CARD_FLIP_MS are coupled to
// srm.css (chipDrop 0.3s and the 0.8s card flip) — keep them in sync if the CSS changes.
export const TIMING = {
  BATCH_MS: 200,
  CHIP_SETTLE_MS: 350,
  CARD_FLIP_MS: 800,
  ACK_TIMEOUT_MS: 4000, // how long to wait for a bet ack before rolling the optimistic chip back
};

// A pointer that moves more than this (px) before lift is treated as a scroll, not a tap, so the
// optimistic chip placed on pointerdown is rolled back (Phase 4.2). The board is taller than the
// viewport on mobile, so a vertical pan must never leave a stray bet behind.
export const MOVE_CANCEL_PX = 12;
