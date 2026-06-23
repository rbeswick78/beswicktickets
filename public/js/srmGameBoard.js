/* srmGameBoard.js — thin entry for the "Steal Ryan's Money" game board (Phase 5).
 *
 * The ~1850-line monolith was split into focused ES modules under ./srm/ behind this entry, with
 * the ~20 bare module-level globals consolidated into one shared `state` object (srm/state.js).
 * This file owns only the wiring: it preloads card art at module-eval time and, on DOMContentLoaded,
 * reads identity from the <body> data-attributes, sets up the HUD / chip selector / summary toggle,
 * instantiates audio, and registers every Socket.IO handler and DOM event listener. All behavior —
 * timing, DOM ids, CSS classes, socket event names/payloads, the optimistic/reconciliation logic —
 * is unchanged from Phase 4; this was a pure structural move.
 *
 * Loaded as <script type="module"> (deferred) AFTER the classic srmBetReconciler.js + socket.io
 * scripts, so window.SrmBet / window.io are ready when srm/state.js evaluates. */

import { state, socket } from './srm/state.js';
import { TIMING, MOVE_CANCEL_PX } from './srm/constants.js';
import { dbg, delay, showToast } from './srm/util.js';
import { initAudio } from './srm/audio.js';
import { getUserColor } from './srm/board.js';
import { updateLedBalance, restoreLedBalance } from './srm/ledBalance.js';
import { preloadAllCardImages, revealCard, resetCard } from './srm/cards.js';
import {
  applyOptimisticTap,
  revertOptimisticTap,
  placeBet,
  queueBet,
  renderMyChip,
  setChipUI,
  resetRev,
  noteRevWithGap,
  rebuildUIFromState,
} from './srm/bets.js';
import {
  showCardBetResults,
  resolveLMHBets,
  showSummaryPanel,
  hideSummaryPanels,
  clearBetResultAnimations,
} from './srm/results.js';
import { checkAndTriggerCardLongshot, cleanupCelebration } from './srm/celebrate.js';

// Preload all cards immediately when the module loads (before DOMContentLoaded), as in the monolith.
preloadAllCardImages();

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
  const bodyEl = document.querySelector('body');
  state.gameId = bodyEl.getAttribute('data-game-id');
  state.currentUserId = bodyEl.getAttribute('data-current-user-id');
  const dealerId = bodyEl.getAttribute('data-dealer-id');
  state.isDealer = (state.currentUserId === dealerId);

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
      state.selectedBetAmount = parseInt(chip.dataset.value, 10);

      // Update cursor
      updateChipCursor(state.selectedBetAmount);
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
  initAudio();

  // Helper for updating or creating a new player-balance item
  function updatePlayerBalance(userId, username, balance) {
    let balanceItem = document.getElementById(`balance-${userId}`);
    if (!balanceItem) {
      balanceItem = document.createElement('div');
      balanceItem.id = `balance-${userId}`;
      balanceItem.className = `balance-item${userId === state.currentUserId ? ' current-user' : ''}`;
      balanceList.appendChild(balanceItem);
    }
    // Update color just in case
    balanceItem.style.color = getUserColor(userId);
    balanceItem.textContent = `${username}: ${balance}`;

    // Update the LED balance display for current user
    if (userId === state.currentUserId && myBalanceDisplay) {
      // Determine if this is a win (balance increased from server perspective)
      // and we're in results phase (cards have been dealt)
      const isWin = balance > state.actualBalance && (state.currentRoundStatus === 'resultsPending' || state.currentRoundStatus === 'results');

      // Animate if balance changed and we have a prior value
      const shouldAnimate = state.actualBalance !== 0 && balance !== state.actualBalance;

      updateLedBalance(balance, shouldAnimate, isWin);
    }
  }

  // Join Socket.IO room for this game
  socket.emit('joinGameRoom', { gameId: state.gameId, userId: state.currentUserId });
  socket.emit('requestGameData', { gameId: state.gameId });

  // On receiving the entire game data
  socket.on('gameData', (data) => {
    data.players.forEach((player) => {
      state.userColorMap[player.userId] = player.color;

      // During dealing phase, cache balance updates to prevent spoilers
      if (state.isDealingPhase) {
        state.ticketUpdateCache.push({
          userId: player.userId,
          username: player.username,
          ticketBalance: player.ticketBalance
        });
      } else {
        // Initialize LED balance for current user (no animation on load)
        if (player.userId === state.currentUserId) {
          state.displayedBalance = player.ticketBalance;
          state.actualBalance = player.ticketBalance;
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
    if (!state.isDealingPhase) {
      if (typeof data.roundStatus === 'string') state.currentRoundStatus = data.roundStatus;
      rebuildUIFromState(data);
    }
  });

  // Reconnect resync (Phase 4.4): a dropped-then-restored socket is a fresh connection that is no
  // longer in the game room, so re-join and pull absolute truth. rebuildUIFromState (via gameData)
  // is idempotent and resets the optimistic state, so any bets lost across the gap self-heal.
  socket.on('connect', () => {
    const gId = state.gameId;
    if (!gId) return;
    socket.emit('joinGameRoom', { gameId: gId, userId: state.currentUserId });
    socket.emit('requestGameData', { gameId: gId });
  });

  // Listen for colorAssignment
  socket.on('colorAssignment', (data) => {
    const { userId, color } = data;
    state.userColorMap[userId] = color;
  });

  // Listen for playerList
  socket.emit('requestPlayers', { gameId: state.gameId });
  socket.on('playerList', (players) => {
    players.forEach((player) => {
      state.userColorMap[player.userId] = player.color;

      // Initialize LED balance for current user if not already set
      if (player.userId === state.currentUserId && state.actualBalance === 0) {
        state.displayedBalance = player.ticketBalance;
        state.actualBalance = player.ticketBalance;
      }

      updatePlayerBalance(player.userId, player.username, player.ticketBalance);
    });
  });

  // Listen for ticketUpdate - cache during dealing to prevent balance spoilers
  socket.on('ticketUpdate', (data) => {
    if (state.isDealingPhase) {
      // Cache the update until cards finish flipping
      state.ticketUpdateCache.push(data);
    } else {
      updatePlayerBalance(data.userId, data.username, data.ticketBalance);
    }
  });

  // cardsDealt => do a time-staggered reveal with progressive results
  socket.on('cardsDealt', async (dealData) => {
    dbg('[cardsDealt] arrived, starting progressive reveal sequence');

    // Enter dealing phase - cache any ticketUpdate events until cards finish flipping
    state.isDealingPhase = true;

    // Cache the dealt cards for results display
    state.dealtCardsCache = {
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

    state.currentRoundStatus = 'resultsPending';

    // Helper to wait for bet results if not yet available
    async function waitForBetResults(maxWait = 5000) {
      const startTime = Date.now();
      while (!state.betResultsCache && (Date.now() - startTime) < maxWait) {
        await delay(100);
      }
      return state.betResultsCache;
    }

    // ===== CARD 1 =====
    dbg('[cardsDealt] Revealing Card 1');
    state.stealAudio.play().catch(err => {
      console.warn('Audio play failed for steal.mp3:', err);
    });
    if (titleSteal) titleSteal.classList.add('highlight');

    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot1, dealData.card1, 'Card 1');
    await delay(TIMING.CARD_FLIP_MS); // Wait for flip animation (0.8s CSS transition)

    // Show bet results for card 1 (if we have them)
    let betResults = state.betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(1, betResults);
      // Check for longshot on card 1
      await checkAndTriggerCardLongshot(1, state.longShotWinsCache);
    }

    // Remove highlight from "Steal"
    if (titleSteal) titleSteal.classList.remove('highlight');

    // Delay before next card
    await delay(1500);

    // ===== CARD 2 =====
    dbg('[cardsDealt] Revealing Card 2');
    state.ryansAudio.play().catch(err => {
      console.warn('Audio play failed for ryans.mp3:', err);
    });
    if (titleRyans) titleRyans.classList.add('highlight');

    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot2, dealData.card2, 'Card 2');
    await delay(TIMING.CARD_FLIP_MS);

    // Show bet results for card 2
    betResults = state.betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(2, betResults);
      // Check for longshot on card 2
      await checkAndTriggerCardLongshot(2, state.longShotWinsCache);
    }

    // Remove highlight from "Ryan's"
    if (titleRyans) titleRyans.classList.remove('highlight');

    // Delay before next card
    await delay(1500);

    // ===== CARD 3 =====
    dbg('[cardsDealt] Revealing Card 3');
    state.moneyAudio.play().catch(err => {
      console.warn('Audio play failed for money.mp3:', err);
    });
    if (titleMoney) titleMoney.classList.add('highlight');

    // Wait for card to start flipping, then wait for flip animation to complete
    await revealCard(cardSlot3, dealData.card3, 'Card 3');
    await delay(TIMING.CARD_FLIP_MS);

    // Show bet results for card 3
    betResults = state.betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(3, betResults);
      // Check for longshot on card 3
      await checkAndTriggerCardLongshot(3, state.longShotWinsCache);

      // ===== L/M/H RESOLUTION =====
      // Now that all 3 cards are revealed, resolve all pending L/M/H bets
      // This creates a dramatic "moment of truth" where all L/M/H chips resolve simultaneously
      await delay(500); // Brief pause before the big reveal
      await resolveLMHBets(betResults);
    }

    // Remove highlight from "Money"
    if (titleMoney) titleMoney.classList.remove('highlight');

    // Apply cached ticket updates now that all cards are revealed
    state.ticketUpdateCache.forEach(data => {
      updatePlayerBalance(data.userId, data.username, data.ticketBalance);
    });
    state.ticketUpdateCache = [];
    state.isDealingPhase = false;

    // Show summary panel after a brief delay
    await delay(1000);

    if (betResults) {
      showSummaryPanel(betResults);
    }

    // Clear longshot cache
    state.longShotWinsCache = null;

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
    state.longShotWinsCache = longShotWins;
  });

  // payouts => cache for progressive reveal (cardsDealt handles the display)
  socket.on('payoutResults', (betResults) => {
    dbg('[payoutResults] event arrived, caching for progressive reveal');
    // Store in betResultsCache for the progressive reveal sequence to use
    state.betResultsCache = betResults;

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
    if (state.currentRoundStatus !== 'betting') return;
    const spotId = area.getAttribute('data-spot-id');
    if (!spotId) return;
    pressFeedback(area);
    activePointers.set(e.pointerId, { spotId, x: e.clientX, y: e.clientY, amount: state.selectedBetAmount });
    applyOptimisticTap(spotId, state.selectedBetAmount); // render now; the network send waits for pointerup
  }

  bettableAreas.forEach((area) => {
    if (window.PointerEvent) {
      area.addEventListener('pointerdown', (e) => beginPlacement(area, e));
    } else {
      area.addEventListener('click', () => {
        if (state.currentRoundStatus !== 'betting') return;
        const spotId = area.getAttribute('data-spot-id');
        if (spotId) placeBet(spotId, state.selectedBetAmount);
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
      typeof data.rev === 'number' && state.lastAppliedRev != null && data.rev <= state.lastAppliedRev;
    if (Array.isArray(data.bets)) {
      data.bets.forEach(bet => {
        if (String(bet.userId) === String(state.currentUserId)) {
          if (!staleForMe) {
            state.reconciler.setConfirmed(bet.spotId, bet.total);
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

        socket.emit('dealCards', { gameId: state.gameId, userId: state.currentUserId });
      } else if (dealButton.textContent === 'Clear') {
        socket.emit('clearRound', { gameId: state.gameId, userId: state.currentUserId });
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
    state.reconciler.resyncFrom([]);
    state.pendingBets = [];
    if (state.batchTimer) { clearTimeout(state.batchTimer); state.batchTimer = null; }
    resetRev(data && data.rev);

    // Hide summary panels
    hideSummaryPanels();

    if (state.isDealer && dealButton) {
      dealButton.textContent = 'Deal';
      dealButton.classList.remove('dealing');
    }
    state.currentRoundStatus = 'betting';

    // Reset cards to face down (flip back)
    resetCard(cardSlot1);
    resetCard(cardSlot2);
    resetCard(cardSlot3);

    // Play "place-your-bets" audio when the round is cleared
    if (state.placeYourBetsAudio) {
      state.placeYourBetsAudio.play().catch(err => {
        console.warn('Audio play failed:', err);
      });
    }

    // Reset flags for all clients
    state.betResultsCache = null;  // Also clear the new cache
    state.dealtCardsCache = null;
    state.longShotWinsCache = null;
    state.longShotCelebrationActive = false;
    state.ticketUpdateCache = [];
    state.isDealingPhase = false;

    // Sync displayed balance with actual (in case of any drift)
    state.displayedBalance = state.actualBalance;
    const ledDisplay = document.getElementById('my-balance-amount');
    if (ledDisplay) {
      ledDisplay.textContent = state.actualBalance.toLocaleString();
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
