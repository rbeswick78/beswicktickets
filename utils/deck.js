// deck.js

/**
 * Returns an unshuffled, 54-card deck:
 *  - 52 standard cards
 *  - 2 Jokers
 */
function getDeckOf54() {
  const suits = ['♣', '♦', '♥', '♠'];
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

  const deck = [];

  // Add 52 normal cards
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        rank,
        suit,
        display: `${rank}${suit}`, // e.g. "A♣", "10♦"
        isJoker: false,
      });
    }
  }

  // Add 2 jokers
  deck.push({ rank: 'Joker', suit: '', display: 'Joker 1', isJoker: true });
  deck.push({ rank: 'Joker', suit: '', display: 'Joker 2', isJoker: true });

  return deck;
}

/**
 * Fisher-Yates shuffle to randomize array in place
 */
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Helper to get a freshly shuffled 54-card deck
 */
function getShuffledDeckOf54() {
  const deck = getDeckOf54();
  return shuffleDeck(deck);
}

module.exports = {
  getDeckOf54,
  shuffleDeck,
  getShuffledDeckOf54,
};