// models/TicketAward.js
const mongoose = require('mongoose');

const ticketAwardSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quantity: { type: Number, required: true },
  reason: { type: String },
  token: { type: String, required: true, unique: true },
  redeemed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  redeemedAt: { type: Date },
});

const TicketAward = mongoose.model('TicketAward', ticketAwardSchema);
module.exports = TicketAward;