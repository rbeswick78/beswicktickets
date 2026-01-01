// socket.js

import { fetchAndRenderUsers, animateTicketBalance } from './ui.js';

// Establish a socket connection
const socket = window.io();

// Function to initialize socket event listeners
function initializeSocket() {
  // Listen for ticket updates
  socket.on('ticketUpdate', (data) => {
    const { userId, ticketBalance } = data;

    // Find the user card with the matching userId
    const userCard = document.querySelector(`.index-user-card[data-user-id='${userId}']`);
    if (userCard) {
      const oldBalance = parseInt(userCard.dataset.currentTicketBalance, 10) || 0;
      const newBalance = ticketBalance;

      animateTicketBalance(userCard, oldBalance, newBalance);
    }
  });

  // Handle new user events
  socket.on('newUser', () => {
    fetchAndRenderUsers();
  });

  // Handle user deletion events
  socket.on('userDeleted', (data) => {
    const { userId } = data;
    const userCard = document.querySelector(`.index-user-card[data-user-id='${userId}']`);
    if (userCard) {
      userCard.remove();
    }
  });
}

export { socket, initializeSocket };