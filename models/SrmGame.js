const mongoose = require('mongoose');

const srmGameSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true }, // 3-digit code
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, default: 'active' }, // 'active', 'ended', etc.
  createdAt: { type: Date, default: Date.now },
  // Add fields to store current bets, the three cards, etc.
  bets: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      spotId: String,
      amount: Number,
      // ...any other info needed
    }
  ],
  // NEW FIELDS FOR STORING ROUND STATE
  roundStatus: {
    type: String,
    default: 'betting', // e.g. 'betting', 'results', etc.
  },
  dealtCards: {
    // e.g. an array of card objects [{rank, suit, display, isJoker}, ...]
    type: [Object],
    default: [],
  },
});

module.exports = mongoose.model('srmGame', srmGameSchema);