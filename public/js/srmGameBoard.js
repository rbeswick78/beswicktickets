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
let roundResultsAudio; // NEW: Added for round-results.mp3

/**
 * A map to store userId -> color
 */
const userColorMap = {};
const socket = window.io();
const possibleColors = [
  '#f44336',
  '#2196f3',
  '#4caf50',
  '#ff9800',
  '#9c27b0',
  '#e91e63',
];

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
 * Create a chip element, including the click-to-remove logic for the current user only
 */
function createChipElement(userId, amount, spotId) {
  const chipEl = document.createElement('div');
  chipEl.classList.add('chip');
  chipEl.dataset.userId = userId;
  chipEl.dataset.amount = amount;
  chipEl.dataset.spotId = spotId;
  chipEl.style.backgroundColor = getUserColor(userId);
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
 * Reveal a single card's image in the specified DOM slot
 */
function revealCard(slotEl, card, altText) {
  const img = slotEl.querySelector('img');
  if (img) {
    img.src = getCardImageSrc(card);
    img.alt = altText;
  }
}

/**
 * Called once we have betResults and we can safely show them (e.g.,
 * after the last card + an additional delay).
 */
function showPayoutResults(betResults) {
  const payoutResultsList = document.getElementById('payout-results-list');
  payoutResultsList.innerHTML = '';

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
    const { username, cardNumber, betDescr, wager, net } = result;
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
 * Position chips in a grid
 */
function positionChips(parentEl) {
  const chipEls = Array.from(parentEl.querySelectorAll('.chip'));

  const chipSize = 32; // base size
  const gap = 2;

  chipEls.forEach((chip, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const topPx = row * (chipSize + gap);
    const leftPx = col * (chipSize + gap);

    chip.style.top = topPx + 'px';
    chip.style.left = leftPx + 'px';
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

  // -------------------------------------------------------------
  //  Make player-balances container draggable
  // -------------------------------------------------------------
  const playerBalances = document.getElementById('player-balances');
  playerBalances.style.position = 'absolute';

  function makeElementDraggable(element) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    // Helper functions for starting, moving, and ending a drag
    const startDrag = (clientX, clientY) => {
      isDragging = true;
      offsetX = clientX - element.offsetLeft;
      offsetY = clientY - element.offsetTop;
      element.style.zIndex = 9999;
    };

    const doDrag = (clientX, clientY) => {
      if (!isDragging) return;
      const x = clientX - offsetX;
      const y = clientY - offsetY;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    };

    const endDrag = () => {
      isDragging = false;
    };

    // Mouse events
    element.addEventListener('mousedown', (event) => {
      startDrag(event.clientX, event.clientY);
    });

    document.addEventListener('mousemove', (event) => {
      doDrag(event.clientX, event.clientY);
    });

    document.addEventListener('mouseup', endDrag);

    // Touch events for mobile
    element.addEventListener('touchstart', (event) => {
      // Prevent default so we can handle the touch ourselves
      event.preventDefault();
      const touch = event.touches[0];
      startDrag(touch.clientX, touch.clientY);
    }, { passive: false });

    document.addEventListener('touchmove', (event) => {
      event.preventDefault();
      const touch = event.touches[0];
      doDrag(touch.clientX, touch.clientY);
    }, { passive: false });

    document.addEventListener('touchend', endDrag);
    // (Optional) also listen for 'touchcancel' if you want to handle canceled drags
  }

  makeElementDraggable(playerBalances);

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

  roundResultsAudio = new Audio('/sound/round-results.mp3'); // NEW
  roundResultsAudio.load(); // NEW

  // -------------------------------------------------------------
  //  End draggable code; below is your existing code.
  // -------------------------------------------------------------

  // Helper for updating or creating a new player-balance item
  function updatePlayerBalance(userId, username, balance) {
    let balanceItem = document.getElementById(`balance-${userId}`);
    if (!balanceItem) {
      balanceItem = document.createElement('div');
      balanceItem.id = `balance-${userId}`;
      balanceItem.className = `balance-item${userId === currentUserId ? ' current-user' : ''}`;
      balanceList.appendChild(balanceItem);
    }
    balanceItem.style.color = getUserColor(userId);
    balanceItem.textContent = `${username}: ${balance}`;
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

    // Reset facedown cards
    const img1 = cardSlot1.querySelector('img');
    if (img1) {
      img1.src = '/svg/cards/2B.svg';
      img1.alt = 'Card Back';
    }
    const img2 = cardSlot2.querySelector('img');
    if (img2) {
      img2.src = '/svg/cards/2B.svg';
      img2.alt = 'Card Back';
    }
    const img3 = cardSlot3.querySelector('img');
    if (img3) {
      img3.src = '/svg/cards/2B.svg';
      img3.alt = 'Card Back';
    }

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
    alert(data.message);
  });
});