/* srm/results.js — per-card bet-result reveal & the round summary panel (Phase 5).
 *
 * Drives the win/lose/push chip effects as each card flips, the deferred L/M/H "moment of truth",
 * the desktop+mobile summary panels, and the teardown of all result animations on clear. Reads the
 * shared `state` (current user, round-results audio) and the board's colour helper; owns no state
 * of its own. */

import { state } from './state.js';
import { delay, dbg, showToast } from './util.js';
import { getUserColor } from './board.js';

/**
 * Show bet results for a specific card with chip animations
 * @param {number} cardNumber - 1, 2, or 3
 * @param {Array} allBetResults - All bet results from the server
 * @returns {Promise} - Resolves when animations complete
 */
export async function showCardBetResults(cardNumber, allBetResults) {
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
export async function resolveLMHBets(allBetResults) {
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
 * Show the inline summary panel with round results
 * @param {Array} betResults - All bet results
 */
export function showSummaryPanel(betResults) {
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
  const myData = playerTotals[state.currentUserId];
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
        if (player.userId === state.currentUserId) el.classList.add('is-you');
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
  if (state.roundResultsAudio) {
    state.roundResultsAudio.play().catch(err => {
      console.warn('Audio play failed for round-results.mp3:', err);
    });
  }
}

/**
 * Hide the summary panels
 */
export function hideSummaryPanels() {
  const summaryPanel = document.getElementById('summary-panel');
  const summaryPanelMobile = document.getElementById('summary-panel-mobile');

  if (summaryPanel) summaryPanel.classList.remove('visible');
  if (summaryPanelMobile) summaryPanelMobile.classList.remove('visible', 'minimized');
}

/**
 * Clear all bet result animations and badges
 */
export function clearBetResultAnimations() {
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
