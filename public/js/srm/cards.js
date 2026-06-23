/* srm/cards.js — card image resolution, preloading, and the 3D flip reveal (Phase 5).
 *
 * No game state of its own; depends only on the debug logger. */

import { dbg } from './util.js';

/**
 * Helper function to determine the correct card image filename (SVG).
 */
export function getCardImageSrc(card) {
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
 * Preload ALL card SVGs on page load for instant responsiveness
 */
export function preloadAllCardImages() {
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

/**
 * Reveal a single card's image in the specified DOM slot using 3D flip
 * @returns {Promise} - Resolves when the flip animation has started
 */
export function revealCard(slotEl, card, altText) {
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
export function resetCard(slotEl) {
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
