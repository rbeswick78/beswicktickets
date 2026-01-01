// main.js

import { initializeSocket } from './socket.js';
import { loadAllSounds, playEnterSound } from './sound.js';
import { fetchAndRenderUsers } from './ui.js';
import { createDotMatrix } from './dotMatrix.js';

document.addEventListener('DOMContentLoaded', () => {
  // Hide the user containers and page title initially
  const userContainers = document.getElementById('user-containers');
  userContainers.style.display = 'none';
  const pageTitle = document.getElementById('page-title');
  pageTitle.style.display = 'none'; // Hide the title initially

  // Render "ENTER" as a dot matrix
  const enterButton = document.getElementById('enter-button');
  enterButton.appendChild(createDotMatrix('ENTER'));

  // Add event listener for the "ENTER" dot matrix
  enterButton.addEventListener('click', () => {
    // Load sounds when the user interacts with the page
    loadAllSounds()
      .then(() => {
        // Play the enter sound at normal speed
        return playEnterSound();
      })
      .then(() => {
        console.log('Sounds loaded and enter sound played');
        // Proceed with the rest of the setup after the sound plays
        setupPage();
      })
      .catch((error) => {
        console.error('Error loading sounds or playing enter sound:', error);
        // Proceed even if there's an error loading sounds or playing sound
        setupPage();
      });
  });

  function setupPage() {
    // Hide the "ENTER" dot matrix and show the user containers and page title
    enterButton.style.display = 'none';
    userContainers.style.display = 'flex';

    // Render "BESWICK TICKETS" as a dot matrix and make it visible
    pageTitle.innerHTML = ''; // Clear any existing content
    pageTitle.appendChild(createDotMatrix('BESWICK TICKETS'));
    pageTitle.style.display = 'block'; // Show the title after clicking enter

    // Fetch and render users
    fetchAndRenderUsers();

    // Initialize socket event listeners
    initializeSocket();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js')
        .then(registration => {
          console.log('Service Worker registered with scope:', registration.scope);
        })
        .catch(error => {
          console.error('Service Worker registration failed:', error);
        });
    });
  }
});