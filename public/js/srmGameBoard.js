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
};

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
    batchTimer = setTimeout(sendPendingBets, TIMING.BATCH_MS);
  }
}

function updateChipUI(userId, spotId, amount) {
  const targetEl = getBetSpotElement(spotId);

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

  // Mark chip as settled after drop animation completes to prevent re-animation
  setTimeout(() => {
    chipEl.classList.add('chip-settled');
  }, TIMING.CHIP_SETTLE_MS); // matches srm.css chipDrop (0.3s)

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
  // We need to handle that the suits order in spotId might differ from betDescr
  const betLookup = {};
  cardBets.forEach(bet => {
    // Convert betDescr to spotId format
    // Server betDescr examples: "Diamonds", "Hearts or Clubs", "Odd", "Joker", "Lowest"
    // DOM spotId examples: "card1-suit-♦", "card1-suits-♥♣", "card1-odd", "card1-joker", "card1-low"
    let spotId = `card${cardNumber}-`;
    const descr = bet.betDescr.toLowerCase();
    
    if (descr.includes(' or ')) {
      // Double suit bet like "Hearts or Clubs"
      // The order in the server description matches the spotId order
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
    dbg(`[showCardBetResults] Creating lookup key: ${key} for bet:`, bet.betDescr);
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
  
  // Helper to convert suit name to symbol (same as in showCardBetResults)
  function suitNameToSymbol(name) {
    switch (name.toLowerCase()) {
      case 'spades': return '♠';
      case 'hearts': return '♥';
      case 'diamonds': return '♦';
      case 'clubs': return '♣';
      default: return name;
    }
  }
  
  // Build lookup from all bet results
  const betLookup = {};
  allBetResults.forEach(bet => {
    const cardNumber = bet.cardNumber;
    let spotId = `card${cardNumber}-`;
    const descr = bet.betDescr.toLowerCase();
    
    if (descr.includes(' or ')) {
      const suits = descr.split(' or ').map(s => suitNameToSymbol(s.trim()));
      spotId += 'suits-' + suits.join('');
    } else if (['diamonds', 'hearts', 'spades', 'clubs'].includes(descr)) {
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
      spotId += descr.replace(/\s+/g, '-');
    }
    
    const key = `${bet.userId}:${spotId}`;
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
  const { roundStatus, dealtCards, bets } = gameState;

  // 1) Clear existing chips
  document.querySelectorAll('.chip').forEach(chip => chip.remove());

  // 2) We avoid automatically revealing all three cards if roundStatus === 'resultsPending'.
  //    Instead, rely on timed reveal in socket.on('cardsDealt').

  // 3) Render current bets as chips
  if (bets && bets.length > 0) {
    bets.forEach((bet) => {
      const { userId, spotId, amount } = bet;
      const targetEl = getBetSpotElement(spotId);

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
        // Mark as settled immediately during rebuild - no animation needed
        chipEl.classList.add('chip-settled');
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
    
    // Don't rebuild UI during dealing phase - it would wipe out winning/losing chip effects
    if (!isDealingPhase) {
      rebuildUIFromState(data, currentUserId, isDealer);
    }
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
  socket.on('roundCleared', () => {
    // Clear all bet result animations and badges first
    clearBetResultAnimations();
    
    // Remove all chips
    document.querySelectorAll('.chip').forEach(chip => chip.remove());
    
    
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

  // betError => show a popup
  socket.on('betError', (data) => {
    // Replaced alert with showToast
    showToast(data.message, 'error');
  });
});
