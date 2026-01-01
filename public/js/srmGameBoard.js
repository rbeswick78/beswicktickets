/**
 * Make sure the two variables (finishedDealing, payoutResultsCache) are defined
 * in a scope accessible to all the code that references them. For example, define
 * them at the top of your file (outside any function) or at least before
 * we register the "DOMContentLoaded" listener.
 */

let currentRoundStatus = 'betting';
let finishedDealing = false;    // Track if the 3rd card is shown
let payoutResultsCache = null;  // Store results until the flips are done

// Added audio variables
let placeYourBetsAudio;
let stealAudio;
let ryansAudio;
let moneyAudio;
let roundResultsAudio; 

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
      socket.emit('removeBet', {
        gameId,
        userId: currentUserId,
        spotId,
        amount: 1
      });
    });
  }
  return chipEl;
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
  const payoutResultsList = document.getElementById('payout-results-list');
  payoutResultsList.innerHTML = '';

  // Calculate total net for current user for celebration
  let myNet = 0;

  // Create table
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Player</th>
      <th>Card</th>
      <th>Bet</th>
      <th>Wager</th>
      <th>Net</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Sort results by username then cardNumber
  betResults.sort((a, b) => {
    if (a.username !== b.username) {
      return a.username.localeCompare(b.username);
    }
    return a.cardNumber - b.cardNumber;
  });

  betResults.forEach((result) => {
    const { userId, username, cardNumber, betDescr, wager, net } = result;
    
    if (userId === currentUserId) {
        myNet += net;
    }

    const row = document.createElement('tr');

    // Format net with sign
    const sign = net > 0 ? '+' : (net < 0 ? '-' : '');
    const netCellText = `${sign}${Math.abs(net)}`;

    row.innerHTML = `
      <td>${username}</td>
      <td>${cardNumber}</td>
      <td>${betDescr}</td>
      <td>${wager}</td>
      <td>${netCellText}</td>
    `;

    // Highlight winning rows
    if (net > 0) {
      row.style.backgroundColor = 'rgba(255, 215, 0, 0.2)';
    }

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  payoutResultsList.appendChild(table);

  // Show the overlay
  document.getElementById('payout-results').style.display = 'block';

  // Celebration if won
  if (myNet > 0) {
      showToast(`You won ${myNet} tickets! 🎉`, 'success');
  }

  // If dealer, make sure button says "Clear"
  if (isDealer) {
    const dealButton = document.getElementById('deal-button');
    if (dealButton) dealButton.textContent = 'Clear';
  }
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
  
  // We want to fit up to 4 chips nicely in a 2x2 grid, 
  // and then start stacking/overlapping if there are more.
  
  chipEls.forEach((chip, index) => {
    // 2x2 grid logic
    // 0 | 1
    // -----
    // 2 | 3
    
    // For 5+, we cycle or just stack. Let's stack cyclically.
    const gridPos = index % 4;
    
    const col = gridPos % 2; 
    const row = Math.floor(gridPos / 2);
    
    // Base offsets (in %)
    // Cell is 100% x 100%. Chip is roughly 50% x 50% (3.2em in 6em cell ~= 53%)
    // Let's create a slight overlap to center them better.
    // 5% margin?
    
    const size = 50; // Use about 50% width implicitly by positioning
    const gap = 0;
    
    // We want to center the 2x2 block.
    // If we put left at 0% and 50%, they cover the width.
    
    let leftPct = col * 50;
    let topPct = row * 50;
    
    // Add a little randomness or stack offset for >4
    const stackLayer = Math.floor(index / 4);
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
    // The CSS .chip width/height is 3.2em. The cell is 6em.
    // 3.2em is > 50% of 6em (3em). So they will overlap.
    // That's fine, it looks like a pile.
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

    // Also update the fixed footer balance if it's me
    if (userId === currentUserId && myBalanceDisplay) {
        myBalanceDisplay.textContent = balance;
        // Flash effects?
        myBalanceDisplay.style.color = '#fff';
        setTimeout(() => { myBalanceDisplay.style.color = ''; }, 300);
    }
  }

  // Join Socket.IO room for this game
  socket.emit('joinGameRoom', { gameId, userId: currentUserId });
  socket.emit('requestGameData', { gameId });

  // On receiving the entire game data
  socket.on('gameData', (data) => {
    data.players.forEach((player) => {
      userColorMap[player.userId] = player.color;
      updatePlayerBalance(player.userId, player.username, player.ticketBalance);
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
      updatePlayerBalance(player.userId, player.username, player.ticketBalance);
    });
  });

  // Listen for ticketUpdate
  socket.on('ticketUpdate', (data) => {
    updatePlayerBalance(data.userId, data.username, data.ticketBalance);
  });

  // cardsDealt => do a time-staggered reveal
  socket.on('cardsDealt', (dealData) => {
    console.log('[cardsDealt] arrived, starting timeouts');

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
      setTimeout(() => {
        console.log('[cardsDealt] 6s total, check if payoutResultsCache => show overlay');
        if (payoutResultsCache) {
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

  // payouts => display them 2s after last card if done, or cache them
  socket.on('payoutResults', (betResults) => {
    console.log('[payoutResults] event arrived');
    if (finishedDealing) {
      setTimeout(() => {
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
      socket.emit('playerBet', {
        gameId,
        userId: currentUserId,
        spotId,
        amount: 1
      });
    });
  });

  // Listen for betPlaced
  socket.on('betPlaced', (betData) => {
    const { userId, spotId, amount } = betData;
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
      existingChip.dataset.amount = newAmount;
      existingChip.textContent = newAmount;
    } else {
      const chipEl = createChipElement(userId, amount, spotId);
      targetEl.appendChild(chipEl);
    }
    positionChips(targetEl);
  });

  // Deal or Clear
  // Note: dealButton might be null if not dealer
  if (dealButton) {
    dealButton.addEventListener('click', () => {
      if (dealButton.textContent === 'Deal') {
        // IMPORTANT: we must reset these so the new round starts fresh
        finishedDealing = false;
        payoutResultsCache = null;

        socket.emit('dealCards', { gameId });
      } else {
        socket.emit('clearRound', { gameId });
      }
    });
  }

  // Close round results
  closePayoutResultsBtn?.addEventListener('click', () => {
    payoutResultsContainer.style.display = 'none';
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
