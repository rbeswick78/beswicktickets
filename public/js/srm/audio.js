/* srm/audio.js — game audio setup for the SRM game board (Phase 5).
 *
 * The <Audio> objects were created inside DOMContentLoaded in the monolith and stored in bare
 * module globals; they now live on the shared `state`. `initAudio()` is called once at the top of
 * DOMContentLoaded (same timing as before) and the play sites read `state.*Audio` directly. */

import { state } from './state.js';

/**
 * Initialize and load audio files. Called once from DOMContentLoaded.
 */
export function initAudio() {
  state.placeYourBetsAudio = new Audio('/sound/place-your-bets.mp3');
  state.placeYourBetsAudio.load();

  state.stealAudio = new Audio('/sound/steal.mp3');
  state.stealAudio.load();

  state.ryansAudio = new Audio('/sound/ryans.mp3');
  state.ryansAudio.load();

  state.moneyAudio = new Audio('/sound/money.mp3');
  state.moneyAudio.load();

  state.roundResultsAudio = new Audio('/sound/round-results.mp3');
  state.roundResultsAudio.load();

  state.longShotAudio = new Audio('/sound/beswick-boys-rule.mp3');
  state.longShotAudio.load();

  state.winTickAudio = new Audio('/sound/win-single.mp3');
  state.winTickAudio.load();
}
