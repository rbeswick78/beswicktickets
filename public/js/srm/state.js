/* srm/state.js — shared mutable state for the SRM game board (Phase 5).
 *
 * Replaces the ~20 bare module-level globals the monolith carried with ONE object that every
 * feature module imports. All cross-module reads/writes of game-board state go through `state`;
 * no feature module declares its own module-level mutable game state.
 *
 * The transport singletons (`socket`, the reconciler instance) and the pure SrmBet helpers are
 * created/exposed here too. srmBetReconciler.js is loaded as a classic <script> BEFORE this module
 * (see views/srm/gameBoard.ejs) and socket.io's client script likewise, so `window.SrmBet` and
 * `window.io` are guaranteed ready at this module's evaluation time. */

const { createBetReconciler, nextRevState, aggregateBatch } = window.SrmBet;

// Socket.IO transport singleton (the one connection for this page).
export const socket = window.io();

// Pure helpers from the reconciler module, re-exported so feature modules import them from one place.
export { nextRevState, aggregateBatch };

export const state = {
  // Identity — set once in DOMContentLoaded from the <body> data-attributes.
  gameId: null,
  currentUserId: null,
  isDealer: false,

  // Round lifecycle / dealing-phase gate.
  currentRoundStatus: 'betting',
  isDealingPhase: false, // true during the card reveal animation (caches balance spoilers)

  // Dealt cards + caches that hold back results/balances until the reveal finishes.
  dealtCardsCache: null,    // Store dealt cards for results display
  ticketUpdateCache: [],    // Store ticket updates until cards finish flipping
  betResultsCache: null,    // Store all bet results for per-card reveal
  longShotWinsCache: null,
  longShotCelebrationActive: false,

  // Chip selector.
  selectedBetAmount: 1,

  // LED balance animation.
  displayedBalance: 0,      // What's currently shown on the LED
  actualBalance: 0,         // The real server balance
  balanceAnimationId: null, // Animation frame ID for cleanup

  // Optimistic-bet networking. The reconciler (pure, unit-tested in test/srmBetReconciler.test.js)
  // owns the current user's per-spot { confirmed, pending }; `lastAppliedRev` drives gap detection
  // so a missed broadcast triggers a full resync.
  reconciler: createBetReconciler(),
  lastAppliedRev: null,
  pendingBets: [],
  batchTimer: null,

  // userId -> color.
  userColorMap: {},

  // Audio — instantiated in DOMContentLoaded (see srm/audio.js initAudio()).
  placeYourBetsAudio: null,
  stealAudio: null,
  ryansAudio: null,
  moneyAudio: null,
  roundResultsAudio: null,
  longShotAudio: null,
  winTickAudio: null, // count-up tick sound for win animations
};
