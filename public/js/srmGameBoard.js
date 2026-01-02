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
    
    // Trigger the flip
    cardInner.classList.add('flipped');
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
 * Called once we have betResults and we can safely show them (e.g.,
 * after the last card + an additional delay).
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

  // If dealer, make sure button says "Clear"
  if (isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton) dealButton.textContent = 'Clear';
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
  if ((roundStatus === 'results' || roundStatus === 'resultsPending') && isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton) dealButton.textContent = 'Clear';
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
      // Open the sidebar by default
      sidebar.classList.add('open');
      
      hudToggle.addEventListener('click', () => {
          sidebar.classList.add('open');
      });
  }

  if (hudClose && sidebar) {
      hudClose.addEventListener('click', () => {
          sidebar.classList.remove('open');
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

  // cardsDealt => do a time-staggered reveal
  socket.on('cardsDealt', async (dealData) => {
    console.log('[cardsDealt] arrived, preloading images');

    // Enter dealing phase - cache any ticketUpdate events until cards finish flipping
    isDealingPhase = true;

    // Cache the dealt cards for results display
    dealtCardsCache = {
      card1: dealData.card1,
      card2: dealData.card2,
      card3: dealData.card3
    };

    // Preload all card images before starting the flip sequence
    await Promise.all([
      preloadCardImage(dealData.card1),
      preloadCardImage(dealData.card2),
      preloadCardImage(dealData.card3)
    ]);

    console.log('[cardsDealt] images preloaded, starting flip sequence');

    // Immediately show card 1 and play "steal.mp3"
    revealCard(cardSlot1, dealData.card1, 'Card 1');
    stealAudio.play().catch(err => {
      console.warn('Audio play failed for steal.mp3:', err);
    });

    // 2s later => show card 2 and play "ryans.mp3"
    setTimeout(() => {
      console.log('[cardsDealt] 2s later, flipping card 2');
      revealCard(cardSlot2, dealData.card2, 'Card 2');
      ryansAudio.play().catch(err => {
        console.warn('Audio play failed for ryans.mp3:', err);
      });
    }, 2000);

    // 4s later => show card 3 and play "money.mp3"
    setTimeout(() => {
      console.log('[cardsDealt] 4s later, flipping card 3');
      revealCard(cardSlot3, dealData.card3, 'Card 3');
      moneyAudio.play().catch(err => {
        console.warn('Audio play failed for money.mp3:', err);
      });
      finishedDealing = true;

      // Wait 2 more seconds => if we already have payoutResults, show them (and play round results audio)
      setTimeout(async () => {
        console.log('[cardsDealt] 6s total, check if payoutResultsCache => show overlay');
        
        // Apply cached ticket updates now that cards are revealed
        ticketUpdateCache.forEach(data => {
          updatePlayerBalance(data.userId, data.username, data.ticketBalance);
        });
        ticketUpdateCache = [];
        isDealingPhase = false;
        
        if (payoutResultsCache) {
          // Check if we have long shot wins to celebrate first
          if (longShotWinsCache && longShotWinsCache.length > 0) {
            console.log('[cardsDealt] triggering long shot celebration first');
            await triggerLongShotCelebration(longShotWinsCache);
            longShotWinsCache = null;
          }
          
          // NEW: play round-results.mp3 when the round results appear
          roundResultsAudio.play().catch(err => {
            console.warn('Audio play failed for round-results.mp3:', err);
          });
          showPayoutResults(payoutResultsCache);
          payoutResultsCache = null;
        }
      }, 2000);

    }, 4000);

    // We can set global status if we want
    currentRoundStatus = 'resultsPending';
  });

  // longShotWins => trigger celebration before showing results
  socket.on('longShotWins', (longShotWins) => {
    console.log('[longShotWins] event arrived:', longShotWins);
    longShotWinsCache = longShotWins;
  });

  // payouts => display them 2s after last card if done, or cache them
  socket.on('payoutResults', (betResults) => {
    console.log('[payoutResults] event arrived');
    if (finishedDealing) {
      setTimeout(async () => {
        // Apply cached ticket updates now that cards are revealed
        ticketUpdateCache.forEach(data => {
          updatePlayerBalance(data.userId, data.username, data.ticketBalance);
        });
        ticketUpdateCache = [];
        isDealingPhase = false;
        
        // Check if we have long shot wins to celebrate first
        if (longShotWinsCache && longShotWinsCache.length > 0) {
          console.log('[payoutResults] triggering long shot celebration first');
          await triggerLongShotCelebration(longShotWinsCache);
          longShotWinsCache = null;
        }
        
        // NEW: play round-results.mp3 when the round results appear
        roundResultsAudio.play().catch(err => {
          console.warn('Audio play failed for round-results.mp3:', err);
        });
        showPayoutResults(betResults);
      }, 2000);
    } else {
      payoutResultsCache = betResults;
    }
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

        socket.emit('dealCards', { gameId, userId: currentUserId });
      } else {
        socket.emit('clearRound', { gameId, userId: currentUserId });
      }
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
    document.querySelectorAll('.chip').forEach(chip => chip.remove());
    payoutResultsContainer.style.display = 'none';

    if (isDealer) {
      dealButton.textContent = 'Deal';
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
