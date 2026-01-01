// routes/redeemRoutes.js
const express = require('express');
const router = express.Router();
const TicketAward = require('../models/TicketAward');
const User = require('../models/User');

// Redemption page (no authentication required)
router.get('/redeem', async (req, res) => {
  const { token } = req.query;

  try {
    const award = await TicketAward.findOne({ token });

    if (!award) {
      return res.status(400).send('Invalid or expired QR code.');
    }

    if (award.redeemed) {
      return res.status(400).send('This QR code has already been redeemed.');
    }

    // Find the user associated with this award
    const user = await User.findById(award.userId);
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // Add tickets to user account
    await user.addTickets(award.quantity, award.reason);

    // Mark the award as redeemed
    award.redeemed = true;
    award.redeemedAt = new Date();
    await award.save();

    // Emit event to update the ticket balance in real-time
    const io = req.app.get('io');
    io.emit('ticketUpdate', {
      userId: user._id,
      ticketBalance: user.ticketBalance,
    });

    res.send('Tickets successfully added to the account!');
  } catch (err) {
    console.error('Error redeeming tickets:', err);
    res.status(500).send('Internal server error.');
  }
});

module.exports = router;