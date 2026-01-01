// ui.js

import { createDotMatrix } from './dotMatrix.js';
import { socket } from './socket.js';
import { playTicketSound, playLoseSound } from './sound.js';

// Function to fetch and render users
function fetchAndRenderUsers() {
  fetch('/api/users')
    .then((response) => response.json())
    .then((users) => {
      renderUsers(users);
    })
    .catch((err) => console.error('Error fetching users:', err));
}

// Function to render the list of users
function renderUsers(users) {
  const userContainers = document.getElementById('user-containers');
  userContainers.innerHTML = '';

  users.forEach((user) => {
    const userCard = document.createElement('div');
    userCard.className = 'index-user-card';
    userCard.dataset.userId = user._id;
    userCard.dataset.username = user.username;
    userCard.dataset.currentTicketBalance = user.ticketBalance;

    // Create username display
    const usernameDisplay = createDotMatrix(user.username.toUpperCase());
    usernameDisplay.classList.add('username-display');
    userCard.appendChild(usernameDisplay);

    // Create ticket count display
    const ticketDisplay = document.createElement('div');
    ticketDisplay.className = 'ticket-display';
    ticketDisplay.appendChild(
      createDotMatrix(user.ticketBalance.toString().padStart(4, '0'), true)
    );
    userCard.appendChild(ticketDisplay);

    userContainers.appendChild(userCard);
  });
}

// Function to animate ticket balance change
function animateTicketBalance(userCard, oldBalance, newBalance) {
  const ticketDisplay = userCard.querySelector('.ticket-display');
  let currentBalance = oldBalance;

  // Ensure integer values
  oldBalance = Math.round(oldBalance);
  newBalance = Math.round(newBalance);

  // Determine step value
  let stepValue;
  if (newBalance > oldBalance) {
    stepValue = 1; // Tickets are being added
  } else if (newBalance < oldBalance) {
    stepValue = -1; // Tickets are being removed
  } else {
    // No change in balance
    return;
  }

  // Function to update display and play sound
  const updateDisplay = () => {
    if (currentBalance === newBalance) {
      // Animation complete
      return;
    } else {
      currentBalance += stepValue;

      // Update the display
      ticketDisplay.innerHTML = '';
      ticketDisplay.appendChild(
        createDotMatrix(currentBalance.toString().padStart(4, '0'), true)
      );

      // Update the stored current balance
      userCard.dataset.currentTicketBalance = currentBalance;

      // Select appropriate sound function and playback rate
      let playSoundFunction;
      let playbackRate = 1.2; // Adjust playback rate as needed

      if (stepValue > 0) {
        // Tickets being added
        playSoundFunction = playTicketSound;
      } else {
        // Tickets being removed
        playSoundFunction = playLoseSound;
      }

      // Play the sound and proceed to next update
      playSoundFunction(playbackRate)
        .then(() => {
          // Proceed to the next increment after the sound plays
          updateDisplay();
        })
        .catch((error) => {
          console.error('Error playing sound:', error);
          // Proceed without sound if there's an error
          updateDisplay();
        });
    }
  };

  // Start the animation
  updateDisplay(); // Initial call to display the first frame
}

export { fetchAndRenderUsers, renderUsers, animateTicketBalance };