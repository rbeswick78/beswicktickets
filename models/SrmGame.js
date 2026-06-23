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
  // Monotonic revision counter (Phase 3.3). Every committed game mutation ($inc: {rev: 1})
  // — deal, finalize, clear, and the bet commit — advances it. The bet commit captures rev at
  // read and requires it unchanged at write, which closes the ABA window the roundStatus guard
  // cannot see: a deal+clear cycle returns the round to 'betting' with bets:[], indistinguishable
  // from "no change" by status alone, but rev has advanced, so a stale $set no-ops instead of
  // resurrecting cleared bets. Clients can also use rev to detect dropped/out-of-order frames.
  rev: {
    type: Number,
    default: 0,
  },
});

module.exports = mongoose.model('srmGame', srmGameSchema);