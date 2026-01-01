// routes/qrcodeRoutes.js
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const TicketAward = require('../models/TicketAward');
const ensureAuthenticated = require('../middleware/auth');
const checkAdminRole = require('../middleware/authorization');

// Route to generate QR code
router.post('/generate', ensureAuthenticated, checkAdminRole, async (req, res) => {
  const { userId, quantity, reason } = req.body;

  // Generate a unique token
  const token = uuidv4();

  // Save the award details
  const award = new TicketAward({
    userId,
    quantity,
    reason,
    token,
  });

  try {
    await award.save();

    // Generate the redemption URL
    const redemptionUrl = `https://beswicktickets.com/redeem?token=${token}`;

    // Generate QR code image as data URL
    const qrCodeUrl = await QRCode.toDataURL(redemptionUrl);

    // Include the redemptionUrl in the response
    res.json({ qrCodeUrl, redemptionUrl });
  } catch (err) {
    console.error('Error generating QR code:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;