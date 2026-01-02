/**
 * Make sure the two variables (finishedDealing, payoutResultsCache) are defined
 * in a scope accessible to all the code that references them. For example, define
 * them at the top of your file (outside any function) or at least before
 * we register the "DOMContentLoaded" listener.
 */

let currentRoundStatus = 'betting';
let finishedDealing = false;    // Track if the 3rd card is shown
let payoutResultsCache = null;  // Store results until the flips are done
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
 * Flash the LED for bet placement (instant decrement)
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
 * -------------------------------------------------------------
 *  Batch Betting Logic (Global Scope)
 * -------------------------------------------------------------
 */
let pendingBets = [];
let batchTimer = null;

function sendPendingBets() {
  if (pendingBets.length === 0) return;

  // Aggregate locally to reduce payload size
  const aggregated = {};
  pendingBets.forEach(pb => {
    if (!aggregated[pb.spotId]) aggregated[pb.spotId] = 0;
    aggregated[pb.spotId] += pb.amount;
  });

  const finalBets = Object.keys(aggregated).map(spotId => ({
    spotId,
    amount: aggregated[spotId]
  }));

  // Ensure we have gameId/userId from window (set in DOMContentLoaded)
  const gId = window.gameId;
  const uId = window.currentUserId;

  if (finalBets.length > 0 && gId && uId) {
    socket.emit('playerBetBatch', {
      gameId: gId,
      userId: uId,
      bets: finalBets
    });
  }

  pendingBets = [];
  batchTimer = null;
}

function queueBet(spotId, amount) {
  pendingBets.push({ spotId, amount });
  
  // Flash LED for bet placement (only for positive bets, i.e., placing, not removing)
  if (amount > 0) {
    flashBetPlaced(amount);
  }
  
  if (!batchTimer) {
    batchTimer = setTimeout(sendPendingBets, 200);
  }
}

function updateChipUI(userId, spotId, amount) {
  let targetEl;
  if (spotId.includes('suits-')) {
    targetEl = document.querySelector(`.border-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-odd') || spotId.includes('-even')) {
    targetEl = document.querySelector(`.odd-even-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-joker')) {
    targetEl = document.querySelector(`.joker-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-ace')) {
    targetEl = document.querySelector(`.ace-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-low')) {
    targetEl = document.querySelector(`.lowest-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-mid')) {
    targetEl = document.querySelector(`.middle-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-high')) {
    targetEl = document.querySelector(`.highest-bet[data-spot-id="${spotId}"]`);
  } else {
    targetEl = document.querySelector(`.suit-quad[data-spot-id="${spotId}"]`);
  }

  if (!targetEl) return;
  const existingChip = targetEl.querySelector(`.chip[data-user-id="${userId}"]`);
  if (existingChip) {
    const currentAmount = parseInt(existingChip.dataset.amount || '0', 10);
    const newAmount = currentAmount + amount;
    
    if (newAmount <= 0) {
      existingChip.remove();
    } else {
      existingChip.dataset.amount = newAmount;
      existingChip.textContent = newAmount;
    }
  } else if (amount > 0) {
    // Only create if positive
    const chipEl = createChipElement(userId, amount, spotId);
    targetEl.appendChild(chipEl);
  }
  positionChips(targetEl);
}

/**
 * Create a chip element, including the click-to-remove logic for the current user only
 */
function createChipElement(userId, amount, spotId) {
  const chipEl = document.createElement('div');
  chipEl.classList.add('chip');
  chipEl.dataset.userId = userId;
  chipEl.dataset.amount = amount;
  chipEl.dataset.spotId = spotId;
  chipEl.style.color = getUserColor(userId); // Use currentColor in CSS
  chipEl.textContent = amount;

  // Only allow removal if this chip belongs to the current user
  if (userId === currentUserId) {
    chipEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      // Use batch queue for removal (negative selected chip amount)
      queueBet(spotId, -selectedBetAmount);
    });
  }
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
  
  console.log(`[preloadAllCardImages] Preloading ${cardPaths.length} card images`);
}

// Preload all cards immediately when script loads
preloadAllCardImages();

/**
 * Reveal a single card's image in the specified DOM slot using 3D flip
 */
function revealCard(slotEl, card, altText) {
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
      }).catch(() => {
        // Fallback: flip anyway if decode fails
        cardInner.classList.add('flipped');
      });
    } else {
      // Fallback for browsers without decode support
      faceImg.onload = () => cardInner.classList.add('flipped');
      // If already loaded (cached), flip immediately
      if (faceImg.complete) {
        cardInner.classList.add('flipped');
      }
    }
  }
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
  if (spotId.includes('suits-')) {
    return document.querySelector(`.border-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-odd') || spotId.includes('-even')) {
    return document.querySelector(`.odd-even-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-joker')) {
    return document.querySelector(`.joker-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-ace')) {
    return document.querySelector(`.ace-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-low')) {
    return document.querySelector(`.lowest-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-mid')) {
    return document.querySelector(`.middle-bet[data-spot-id="${spotId}"]`);
  } else if (spotId.includes('-high')) {
    return document.querySelector(`.highest-bet[data-spot-id="${spotId}"]`);
  } else {
    return document.querySelector(`.suit-quad[data-spot-id="${spotId}"]`);
  }
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
  // Filter bet results for this card
  const cardBets = allBetResults.filter(bet => bet.cardNumber === cardNumber);
  
  if (cardBets.length === 0) {
    return; // No bets for this card
  }

  // Group bets by spotId to aggregate multiple bets on the same spot by the same user
  const spotResults = {};
  cardBets.forEach(bet => {
    const key = getBetKey(bet.userId, `card${cardNumber}-${bet.betDescr.replace(/\s+/g, '-').toLowerCase()}`);
    // The spotId from betResults might differ from the actual DOM spotId
    // We need to reconstruct it from the bet data
    // Actually, we can use the chips that are already on the board
  });

  // Get all chips on this card's betting container
  const bettingContainer = document.getElementById(`betting-container-${cardNumber}`);
  if (!bettingContainer) return;

  const allChips = bettingContainer.querySelectorAll('.chip');
  
  // Create a map of spotId -> net result for quick lookup
  const spotNetMap = {};
  cardBets.forEach(bet => {
    // Reconstruct the spotId pattern from the bet
    // The server sends betDescr like "Suit ♦" or "Suits ♦♥" or "Odd" etc.
    // We need to match this to the actual spotId on the DOM
    
    // Find the chip by matching user and checking which spot it's in
    allChips.forEach(chip => {
      if (chip.dataset.userId === bet.userId) {
        const chipSpotId = chip.dataset.spotId;
        // Check if this chip's spotId matches the bet's card number
        if (chipSpotId && chipSpotId.startsWith(`card${cardNumber}-`)) {
          if (!spotNetMap[chipSpotId]) {
            spotNetMap[chipSpotId] = {};
          }
          if (!spotNetMap[chipSpotId][bet.userId]) {
            spotNetMap[chipSpotId][bet.userId] = 0;
          }
          // We need to match the bet to the chip more precisely
          // For now, let's use a different approach - iterate through cardBets and find matching chips
        }
      }
    });
  });

  // Better approach: iterate through all chips for this card and determine win/lose
  // We have the betResults which tell us net for each bet
  // Each betResult has: userId, cardNumber, betDescr, wager, net
  
  // Helper to convert suit name to symbol
  function suitNameToSymbol(name) {
    switch (name.toLowerCase()) {
      case 'spades': return '♠';
      case 'hearts': return '♥';
      case 'diamonds': return '♦';
      case 'clubs': return '♣';
      default: return name;
    }
  }
  
  // Create a lookup by constructing expected spotIds from betDescr
  const betLookup = {};
  cardBets.forEach(bet => {
    // Convert betDescr to spotId format
    // Server betDescr examples: "Diamonds", "Hearts or Clubs", "Odd", "Joker", "Lowest"
    // DOM spotId examples: "card1-suit-♦", "card1-suits-♥♣", "card1-odd", "card1-joker", "card1-low"
    let spotId = `card${cardNumber}-`;
    const descr = bet.betDescr.toLowerCase();
    
    if (descr.includes(' or ')) {
      // Double suit bet like "Hearts or Clubs"
      const suits = descr.split(' or ').map(s => suitNameToSymbol(s.trim()));
      spotId += 'suits-' + suits.join('');
    } else if (['diamonds', 'hearts', 'spades', 'clubs'].includes(descr)) {
      // Single suit bet
      spotId += 'suit-' + suitNameToSymbol(descr);
    } else if (descr === 'odd') {
      spotId += 'odd';
    } else if (descr === 'even') {
      spotId += 'even';
    } else if (descr === 'joker') {
      spotId += 'joker';
    } else if (descr === 'ace') {
      spotId += 'ace';
    } else if (descr === 'lowest') {
      spotId += 'low';
    } else if (descr === 'middle') {
      spotId += 'mid';
    } else if (descr === 'highest') {
      spotId += 'high';
    } else {
      // Fallback - shouldn't happen with proper server data
      spotId += descr.replace(/\s+/g, '-');
    }
    
    const key = `${bet.userId}:${spotId}`;
    if (!betLookup[key]) {
      betLookup[key] = { net: 0, wager: 0 };
    }
    betLookup[key].net += bet.net;
    betLookup[key].wager += bet.wager;
  });

  // Now process each chip
  const animationPromises = [];
  
  allChips.forEach(chip => {
    const chipSpotId = chip.dataset.spotId;
    const chipUserId = chip.dataset.userId;
    
    if (!chipSpotId || !chipSpotId.startsWith(`card${cardNumber}-`)) {
      return; // Not for this card
    }
    
    const lookupKey = `${chipUserId}:${chipSpotId}`;
    const result = betLookup[lookupKey];
    
    if (!result) {
      // No result for this chip (shouldn't happen normally)
      return;
    }
    
    const spotEl = chip.parentElement;
    
    // Create and show result badge
    const badge = document.createElement('div');
    badge.className = 'bet-result-badge';
    
    if (result.net > 0) {
      // WIN
      badge.classList.add('win');
      badge.textContent = `+${result.net}`;
      chip.classList.add('winning');
      if (spotEl) spotEl.classList.add('spot-win');
    } else if (result.net < 0) {
      // LOSS
      badge.classList.add('loss');
      badge.textContent = `${result.net}`;
      chip.classList.add('losing');
      if (spotEl) spotEl.classList.add('spot-loss');
    } else {
      // PUSH (net = 0)
      badge.classList.add('push');
      badge.textContent = '0';
    }
    
    // Position badge near the chip
    if (spotEl) {
      spotEl.appendChild(badge);
    }
    
    // Track animation completion
    const animPromise = new Promise(resolve => {
      setTimeout(resolve, result.net >= 0 ? 1200 : 800);
    });
    animationPromises.push(animPromise);
  });

  // Wait for all animations to complete
  await Promise.all(animationPromises);
  
  // Small extra delay for visual clarity
  await delay(300);
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
  
  // Filter for longshots on this specific card
  const cardLongshots = longShotWins.filter(ls => ls.cardNumber === cardNumber);
  
  if (cardLongshots.length > 0) {
    console.log(`[checkAndTriggerCardLongshot] Card ${cardNumber} has longshot wins:`, cardLongshots);
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

  // === Update Desktop Summary Panel ===
  const summaryPanel = document.getElementById('summary-panel');
  const summaryYourNet = document.getElementById('summary-your-net');
  const summaryStandings = document.getElementById('summary-standings');
  const summaryTotalPot = document.getElementById('summary-total-pot');
  const summaryBiggestWin = document.getElementById('summary-biggest-win');
  const summaryBiggestLoss = document.getElementById('summary-biggest-loss');

  if (summaryYourNet) {
    const netSign = myNet > 0 ? '+' : '';
    summaryYourNet.textContent = `${netSign}${myNet}`;
    summaryYourNet.className = 'summary-your-value';
    if (myNet > 0) summaryYourNet.classList.add('positive');
    else if (myNet < 0) summaryYourNet.classList.add('negative');
  }

  if (summaryStandings) {
    summaryStandings.innerHTML = '';
    sortedPlayers.forEach(player => {
      const row = document.createElement('div');
      row.className = 'summary-player-row';
      if (player.userId === currentUserId) row.classList.add('is-you');

      let netClass = 'neutral';
      if (player.totalNet > 0) netClass = 'positive';
      else if (player.totalNet < 0) netClass = 'negative';

      const netSign = player.totalNet > 0 ? '+' : '';
      
      row.innerHTML = `
        <span class="summary-player-name" style="color: ${getUserColor(player.userId)}">${player.username}</span>
        <span class="summary-player-net ${netClass}">${netSign}${player.totalNet}</span>
      `;
      summaryStandings.appendChild(row);
    });
  }

  if (summaryTotalPot) summaryTotalPot.textContent = totalPot;
  if (summaryBiggestWin) summaryBiggestWin.textContent = biggestWin > 0 ? `+${biggestWin}` : '0';
  if (summaryBiggestLoss) summaryBiggestLoss.textContent = biggestLoss < 0 ? biggestLoss : '0';

  // === Update Mobile Summary Panel ===
  const summaryMobileYourNet = document.getElementById('summary-mobile-your-net');
  const summaryMobileStandings = document.getElementById('summary-mobile-standings');
  const summaryMobilePot = document.getElementById('summary-mobile-pot');
  const summaryMobileBest = document.getElementById('summary-mobile-best');
  const summaryMobileWorst = document.getElementById('summary-mobile-worst');

  if (summaryMobileYourNet) {
    const netSign = myNet > 0 ? '+' : '';
    summaryMobileYourNet.textContent = `${netSign}${myNet}`;
    summaryMobileYourNet.className = 'summary-mobile-your-value';
    if (myNet > 0) summaryMobileYourNet.classList.add('positive');
    else if (myNet < 0) summaryMobileYourNet.classList.add('negative');
  }

  if (summaryMobileStandings) {
    summaryMobileStandings.innerHTML = '';
    sortedPlayers.forEach(player => {
      const card = document.createElement('div');
      card.className = 'summary-mobile-player';
      if (player.userId === currentUserId) card.classList.add('is-you');

      let netClass = 'neutral';
      if (player.totalNet > 0) netClass = 'positive';
      else if (player.totalNet < 0) netClass = 'negative';

      const netSign = player.totalNet > 0 ? '+' : '';
      
      card.innerHTML = `
        <div class="summary-mobile-player-name" style="color: ${getUserColor(player.userId)}">${player.username}</div>
        <div class="summary-mobile-player-net ${netClass}">${netSign}${player.totalNet}</div>
      `;
      summaryMobileStandings.appendChild(card);
    });
  }

  if (summaryMobilePot) summaryMobilePot.textContent = totalPot;
  if (summaryMobileBest) summaryMobileBest.textContent = biggestWin > 0 ? `+${biggestWin}` : '0';
  if (summaryMobileWorst) summaryMobileWorst.textContent = biggestLoss < 0 ? biggestLoss : '0';

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
  
  // Remove animation classes from chips
  document.querySelectorAll('.chip.winning, .chip.losing').forEach(chip => {
    chip.classList.remove('winning', 'losing');
  });
  
  // Remove spot highlight classes
  document.querySelectorAll('.spot-win, .spot-loss').forEach(spot => {
    spot.classList.remove('spot-win', 'spot-loss');
  });
}

/**
 * Called once we have betResults and we can safely show them (e.g.,
 * after the last card + an additional delay).
 * NOTE: This is now primarily used for backward compatibility / fallback
 */
function showPayoutResults(betResults) {
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

  // Identify winner(s) and loser(s)
  const maxNet = sortedPlayers.length > 0 ? sortedPlayers[0].totalNet : 0;
  const minNet = sortedPlayers.length > 0 ? sortedPlayers[sortedPlayers.length - 1].totalNet : 0;

  // Get current user's total net
  const myData = playerTotals[currentUserId];
  const myNet = myData ? myData.totalNet : 0;

  // Populate dealt cards display
  if (dealtCardsCache) {
    const card1Img = document.querySelector('#result-card-1 img');
    const card2Img = document.querySelector('#result-card-2 img');
    const card3Img = document.querySelector('#result-card-3 img');
    
    if (card1Img) card1Img.src = getCardImageSrc(dealtCardsCache.card1);
    if (card2Img) card2Img.src = getCardImageSrc(dealtCardsCache.card2);
    if (card3Img) card3Img.src = getCardImageSrc(dealtCardsCache.card3);
  }

  // Populate player standings
  const standingsGrid = document.getElementById('player-standings-grid');
  standingsGrid.innerHTML = '';

  sortedPlayers.forEach((player) => {
    const card = document.createElement('div');
    card.className = 'player-standing-card';

    // Determine card class based on result
    if (player.totalNet > 0 && player.totalNet === maxNet) {
      card.classList.add('winner');
    } else if (player.totalNet < 0 && player.totalNet === minNet) {
      card.classList.add('loser');
    } else if (player.totalNet === 0) {
      card.classList.add('breakeven');
    }

    // Highlight if this is the current user
    if (player.userId === currentUserId) {
      card.classList.add('is-you');
    }

    // Determine net class
    let netClass = 'neutral';
    if (player.totalNet > 0) netClass = 'positive';
    else if (player.totalNet < 0) netClass = 'negative';

    // Format net with sign
    const netSign = player.totalNet > 0 ? '+' : '';
    const netText = `${netSign}${player.totalNet}`;

    // Badge for winner/loser
    let badge = '';
    if (player.totalNet > 0 && player.totalNet === maxNet) {
      badge = '<div class="player-badge">👑</div>';
    } else if (player.totalNet < 0 && player.totalNet === minNet) {
      badge = '<div class="player-badge">💀</div>';
    } else if (player.totalNet === 0) {
      badge = '<div class="player-badge">➖</div>';
    }

    // You indicator
    const youIndicator = player.userId === currentUserId ? '<span class="you-indicator">You</span>' : '';

    card.innerHTML = `
      ${youIndicator}
      <div class="player-name" style="color: ${getUserColor(player.userId)}">${player.username}</div>
      <div class="player-net ${netClass}">${netText}</div>
      <div class="player-wager">Wagered: ${player.totalWager}</div>
      ${badge}
    `;

    standingsGrid.appendChild(card);
  });

  // Populate your bets section
  const yourBetsList = document.getElementById('your-bets-list');
  yourBetsList.innerHTML = '';

  if (myData && myData.bets.length > 0) {
    myData.bets.forEach((bet) => {
      const betItem = document.createElement('div');
      betItem.className = 'bet-item';
      
      const resultClass = bet.net > 0 ? 'win' : (bet.net < 0 ? 'loss' : '');
      const netSign = bet.net > 0 ? '+' : '';
      
      betItem.innerHTML = `
        <span class="bet-description">Card ${bet.cardNumber}: ${bet.betDescr}</span>
        <span class="bet-result ${resultClass}">${netSign}${bet.net}</span>
      `;
      yourBetsList.appendChild(betItem);
    });
  } else {
    yourBetsList.innerHTML = '<div class="bet-item"><span class="bet-description">No bets placed</span></div>';
  }

  // Your net result
  const yourNetValue = document.getElementById('your-net-value');
  const netSign = myNet > 0 ? '+' : '';
  yourNetValue.textContent = `${netSign}${myNet}`;
  yourNetValue.className = myNet > 0 ? 'positive' : (myNet < 0 ? 'negative' : '');

  // Populate round stats
  document.getElementById('stat-total-pot').textContent = totalPot;
  document.getElementById('stat-biggest-win').textContent = biggestWin > 0 ? `+${biggestWin}` : '0';
  document.getElementById('stat-biggest-loss').textContent = biggestLoss < 0 ? biggestLoss : '0';

  // Show the modal
  document.getElementById('payout-results').style.display = 'flex';

  // Trigger confetti for winners
  if (myNet > 0) {
    triggerConfetti();
    showToast(`You won ${myNet} tickets! 🎉`, 'success');
  }

  // If dealer, make sure button says "Clear" and remove dealing state
  if (isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton) {
      dealButton.textContent = 'Clear';
      dealButton.classList.remove('dealing');
    }
  }
}

/**
 * Trigger confetti animation for winners
 */
function triggerConfetti() {
  const container = document.getElementById('confetti-container');
  if (!container) return;

  container.innerHTML = '';

  const colors = ['#d4af37', '#ffd700', '#ff6b6b', '#4ade80', '#60a5fa', '#f472b6'];
  const confettiCount = 50;

  for (let i = 0; i < confettiCount; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 2 + 's';
    confetti.style.transform = `rotate(${Math.random() * 360}deg)`;
    
    // Randomize shape
    if (Math.random() > 0.5) {
      confetti.style.borderRadius = '50%';
    }
    
    container.appendChild(confetti);
    
    // Trigger animation
    setTimeout(() => {
      confetti.classList.add('active');
    }, 50);
  }

  // Clean up after animation
  setTimeout(() => {
    container.innerHTML = '';
  }, 5000);
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
  const { roundStatus, dealtCards, bets } = gameState;

  // 1) Clear existing chips
  document.querySelectorAll('.chip').forEach(chip => chip.remove());

  // 2) We avoid automatically revealing all three cards if roundStatus === 'resultsPending'.
  //    Instead, rely on timed reveal in socket.on('cardsDealt').

  // 3) Render current bets as chips
  if (bets && bets.length > 0) {
    bets.forEach((bet) => {
      const { userId, spotId, amount } = bet;
      let targetEl;

      if (spotId.includes('suits-')) {
        targetEl = document.querySelector(`.border-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-odd') || spotId.includes('-even')) {
        targetEl = document.querySelector(`.odd-even-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-joker')) {
        targetEl = document.querySelector(`.joker-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-ace')) {
        targetEl = document.querySelector(`.ace-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-low')) {
        targetEl = document.querySelector(`.lowest-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-mid')) {
        targetEl = document.querySelector(`.middle-bet[data-spot-id="${spotId}"]`);
      } else if (spotId.includes('-high')) {
        targetEl = document.querySelector(`.highest-bet[data-spot-id="${spotId}"]`);
      } else {
        targetEl = document.querySelector(`.suit-quad[data-spot-id="${spotId}"]`);
      }

      if (!targetEl) return;

      // Either update existing chip or create a new one
      const existingChip = targetEl.querySelector(`.chip[data-user-id="${userId}"]`);
      if (existingChip) {
        const currentAmount = parseInt(existingChip.dataset.amount || '0', 10);
        const newAmount = currentAmount + amount;
        existingChip.dataset.amount = newAmount;
        existingChip.textContent = newAmount;
      } else {
        const chipEl = createChipElement(userId, amount, spotId);
        targetEl.appendChild(chipEl);
      }

      // Reposition chips
      positionChips(targetEl);
    });
  }

  // 4) If roundStatus is 'results' or 'resultsPending' and this user is dealer, show 'Clear'.
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
  const payoutResultsContainer = document.getElementById('payout-results');
  const closePayoutResultsBtn = document.getElementById('close-payout-results');
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
    rebuildUIFromState(data, currentUserId, isDealer);
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
    console.log('[cardsDealt] arrived, starting progressive reveal sequence');

    // Enter dealing phase - cache any ticketUpdate events until cards finish flipping
    isDealingPhase = true;

    // Cache the dealt cards for results display
    dealtCardsCache = {
      card1: dealData.card1,
      card2: dealData.card2,
      card3: dealData.card3
    };

    // Cards are already preloaded on page load, start flip sequence immediately
    console.log('[cardsDealt] starting progressive flip sequence');

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
    console.log('[cardsDealt] Revealing Card 1');
    revealCard(cardSlot1, dealData.card1, 'Card 1');
    stealAudio.play().catch(err => {
      console.warn('Audio play failed for steal.mp3:', err);
    });
    if (titleSteal) titleSteal.classList.add('highlight');
    
    // Wait for flip animation
    await delay(800);
    
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
    console.log('[cardsDealt] Revealing Card 2');
    revealCard(cardSlot2, dealData.card2, 'Card 2');
    ryansAudio.play().catch(err => {
      console.warn('Audio play failed for ryans.mp3:', err);
    });
    if (titleRyans) titleRyans.classList.add('highlight');
    
    // Wait for flip animation
    await delay(800);
    
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
    console.log('[cardsDealt] Revealing Card 3');
    revealCard(cardSlot3, dealData.card3, 'Card 3');
    moneyAudio.play().catch(err => {
      console.warn('Audio play failed for money.mp3:', err);
    });
    if (titleMoney) titleMoney.classList.add('highlight');
    finishedDealing = true;
    
    // Wait for flip animation
    await delay(800);
    
    // Show bet results for card 3
    betResults = betResultsCache || await waitForBetResults();
    if (betResults) {
      await showCardBetResults(3, betResults);
      // Check for longshot on card 3
      await checkAndTriggerCardLongshot(3, longShotWinsCache);
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
    
    console.log('[cardsDealt] Progressive reveal sequence complete');
  });

  // longShotWins => cache for per-card celebrations
  socket.on('longShotWins', (longShotWins) => {
    console.log('[longShotWins] event arrived:', longShotWins);
    longShotWinsCache = longShotWins;
  });

  // payouts => cache for progressive reveal (cardsDealt handles the display)
  socket.on('payoutResults', (betResults) => {
    console.log('[payoutResults] event arrived, caching for progressive reveal');
    // Store in betResultsCache for the progressive reveal sequence to use
    betResultsCache = betResults;
    
    // Also keep payoutResultsCache for backward compatibility
    payoutResultsCache = betResults;
  });


  // Place bets
  const bettableAreas = document.querySelectorAll(
    '.suit-quad, .border-bet, .odd-even-bet, .joker-bet, .ace-bet, .lowest-bet, .middle-bet, .highest-bet'
  );
  bettableAreas.forEach((area) => {
    area.addEventListener('click', () => {
      if (currentRoundStatus !== 'betting') return;
      const spotId = area.getAttribute('data-spot-id');
      // Use batch queue with selected chip amount
      queueBet(spotId, selectedBetAmount);
    });
  });

  // Listen for betPlaced (legacy/single)
  socket.on('betPlaced', (betData) => {
    const { userId, spotId, amount } = betData;
    updateChipUI(userId, spotId, amount);
  });

  // Listen for betPlacedBatch (new)
  socket.on('betPlacedBatch', (data) => {
    if (data.bets && Array.isArray(data.bets)) {
      data.bets.forEach(bet => {
        updateChipUI(bet.userId, bet.spotId, bet.amount);
      });
    }
  });

  // Deal or Clear
  // Note: dealButton might be null if not dealer
  if (dealButton) {
    dealButton.addEventListener('click', () => {
      if (dealButton.textContent === 'Deal') {
        // IMPORTANT: we must reset these so the new round starts fresh
        finishedDealing = false;
        payoutResultsCache = null;

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

  // Close round results
  closePayoutResultsBtn?.addEventListener('click', () => {
    payoutResultsContainer.style.display = 'none';
    // Clear confetti if still running
    const confettiContainer = document.getElementById('confetti-container');
    if (confettiContainer) confettiContainer.innerHTML = '';
  });

  // roundCleared => UI reset
  socket.on('roundCleared', () => {
    // Clear all bet result animations and badges first
    clearBetResultAnimations();
    
    // Remove all chips
    document.querySelectorAll('.chip').forEach(chip => chip.remove());
    
    // Hide legacy modal (if somehow shown)
    payoutResultsContainer.style.display = 'none';
    
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
    finishedDealing = false;
    payoutResultsCache = null;
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

  // removeBet => update UI
  socket.on('betRemoved', (data) => {
    const { userId, spotId, newAmount } = data;
    let chipSelector;

    if (spotId.includes('suits-')) {
      chipSelector = `.border-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-odd') || spotId.includes('-even')) {
      chipSelector = `.odd-even-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-joker')) {
      chipSelector = `.joker-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-ace')) {
      chipSelector = `.ace-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-low')) {
      chipSelector = `.lowest-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-mid')) {
      chipSelector = `.middle-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else if (spotId.includes('-high')) {
      chipSelector = `.highest-bet[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    } else {
      chipSelector = `.suit-quad[data-spot-id="${spotId}"] .chip[data-user-id="${userId}"]`;
    }

    const chipEl = document.querySelector(chipSelector);
    if (!chipEl) return;

    if (newAmount > 0) {
      chipEl.dataset.amount = newAmount;
      chipEl.textContent = newAmount;
    } else {
      chipEl.remove();
    }
    if (chipEl.parentElement) positionChips(chipEl.parentElement);
  });

  // betError => show a popup
  socket.on('betError', (data) => {
    // Replaced alert with showToast
    showToast(data.message, 'error');
  });
});
