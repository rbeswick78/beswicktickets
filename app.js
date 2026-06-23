require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const helmet = require('helmet');
const mongoose = require('./config/db');
require('./config/passport')(passport);

const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const publicRoutes = require('./routes/publicRoutes');
const apiRoutes = require('./routes/apiRoutes');
const qrcodeRoutes = require('./routes/qrcodeRoutes');
const redeemRoutes = require('./routes/redeemRoutes');
const srmRoutes = require('./routes/srmRoutes');

// Import services if needed
const { computePayouts } = require('./services/srmPayoutService');
const { getShuffledDeckOf54 } = require('./utils/deck');
const SrmGame = require('./models/SrmGame');
const User = require('./models/User');

// For color assignment (already in your snippet)
const { getOrAssignColor, removeUserColor } = require('./services/userColorService');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const server = http.createServer(app);
const io = socketIO(server);
app.set('io', io);

const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/admin', adminRoutes);
app.use('/', publicRoutes);
app.use('/api', apiRoutes);
app.use('/qrcodes', qrcodeRoutes);
app.use('/', redeemRoutes);
app.use('/srm', srmRoutes);

app.get('/', (req, res) => {
  res.redirect('/auth/login');
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something went wrong!');
});

// Global serialization queues to prevent race conditions
const gameQueues = {}; // gameId -> Promise chain

function runSerialized(gameId, task) {
  if (!gameQueues[gameId]) {
    gameQueues[gameId] = Promise.resolve();
  }
  // Chain the task. We catch errors inside the chain so one failure doesn't block future tasks.
  const next = gameQueues[gameId].then(task).catch(err => {
    console.error(`Serialized task error for game ${gameId}:`, err);
  });
  gameQueues[gameId] = next;
  return next;
}

// SOCKET.IO EVENTS
io.on('connection', (socket) => {
  console.log('A user connected via WebSocket');

  // Joining a game room
  socket.on('joinGameRoom', async (data) => {
    const { userId, gameId } = data;
    socket.join(`srmGame_${gameId}`);

    // Assign or retrieve color
    const userColor = getOrAssignColor(userId);
    io.to(`srmGame_${gameId}`).emit('colorAssignment', {
      userId,
      color: userColor
    });

    // Save userId so we can remove color on disconnect
    socket.userId = userId;
  });

  // Let the client fetch the current gameState
  // so new/refreshing players can reconstruct bets/cards
  socket.on('requestGameData', async ({ gameId }) => {
    try {
      const game = await SrmGame.findById(gameId).populate('players');
      if (!game) return;

      // Gather player color data
      const players = game.players.map((p) => ({
        userId: p._id.toString(),
        username: p.username,
        ticketBalance: p.ticketBalance,
        color: getOrAssignColor(p._id.toString()),  // from userColorService
      }));

      // Return both game state and player info in the same payload
      socket.emit('gameData', {
        roundStatus: game.roundStatus,
        dealtCards: game.dealtCards,
        bets: game.bets,
        players, // includes each player's assigned color
      });
    } catch (err) {
      console.error('Error sending game data:', err);
    }
  });

  socket.on('ticketUpdate', (data) => {
    const { userId, ticketBalance, username } = data;
    io.emit('playerUpdate', { userId, username, ticketBalance });
  });

  // Batched Bet Handler
  socket.on('playerBetBatch', (batchData) => {
    const { gameId, userId, bets } = batchData; // bets: [{ spotId, amount }, ...]

    runSerialized(gameId, async () => {
      try {
        const game = await SrmGame.findById(gameId);
        if (!game) return;

        // Enforce: betting must be open
        if (game.roundStatus !== 'betting') {
          socket.emit('betError', { message: 'Betting is closed for this round.' });
          return;
        }

        const user = await User.findById(userId);
        if (!user) return;

        // FIX: Validate and calculate actual amounts based on existing bets
        // This prevents refunding more than what was actually bet
        let validatedAddAmount = 0;
        let validatedRefundAmount = 0;
        const validatedBets = [];

        for (const bet of bets) {
          const { spotId, amount } = bet;
          const existingBet = game.bets.find(
            (b) => b.userId.toString() === userId && b.spotId === spotId
          );

          if (amount > 0) {
            // Adding chips - validate user has enough balance (checked later)
            validatedAddAmount += amount;
            validatedBets.push({ spotId, amount });
          } else if (amount < 0) {
            // Removing chips - only allow removal up to existing bet amount
            const existingAmount = existingBet ? existingBet.amount : 0;
            const requestedRemoval = Math.abs(amount);
            const actualRemoval = Math.min(requestedRemoval, existingAmount);

            if (actualRemoval > 0) {
              validatedRefundAmount += actualRemoval;
              validatedBets.push({ spotId, amount: -actualRemoval });
            }
            // Ignore removal requests for bets that don't exist or exceed bet amount
          }
        }

        const netAmount = validatedAddAmount - validatedRefundAmount;

        // Transaction logic on User with validated amounts
        if (netAmount > 0) {
          // SPEND tickets
          if (user.ticketBalance < netAmount) {
            socket.emit('betError', { message: 'Insufficient tickets for these bets.' });
            return;
          }
          await user.removeTickets(netAmount, `Bets placed (Batch) - Game #${game.code}`);
        } else if (netAmount < 0) {
          // REFUND tickets (validated removal amount)
          await user.addTickets(Math.abs(netAmount), `Bets removed (Batch) - Game #${game.code}`);
        }
        // If netAmount === 0, no wallet change needed

        try {
          // Update game bets with validated amounts
          for (const bet of validatedBets) {
            const { spotId, amount } = bet;
            const existingBet = game.bets.find(
              (b) => b.userId.toString() === userId && b.spotId === spotId
            );

            if (existingBet) {
              existingBet.amount += amount;
            } else if (amount > 0) {
              // Only push if positive amount
              game.bets.push({ userId, spotId, amount });
            }
          }

          // Cleanup: Remove any bets that have dropped to <= 0
          game.bets = game.bets.filter(b => b.amount > 0);

          await game.save();
        } catch (saveError) {
          // If game save fails, reverse the user transaction
          console.error('Game save failed, reversing user transaction:', saveError);

          if (netAmount > 0) {
            // We removed tickets, so add them back
            await user.addTickets(netAmount, `Refund - Game #${game.code} Save Failed`);
          } else if (netAmount < 0) {
            // We added tickets, so remove them back
            try {
              await user.removeTickets(Math.abs(netAmount), `Reversal - Game #${game.code} Save Failed`);
            } catch (reversalErr) {
              console.error('Critical: Failed to reverse refund', reversalErr);
            }
          }
          throw saveError;
        }

        // Emit batch confirmation with validated bets
        const confirmedBets = validatedBets.map(b => ({
          userId,
          spotId: b.spotId,
          amount: b.amount
        }));

        io.to(`srmGame_${gameId}`).emit('betPlacedBatch', { bets: confirmedBets });

        // Emit live balance update to all players in the game room
        io.to(`srmGame_${gameId}`).emit('ticketUpdate', {
          userId: user._id.toString(),
          username: user.username,
          ticketBalance: user.ticketBalance
        });

      } catch (error) {
        console.error('Error processing bet batch:', error);
      }
    });
  });

  // DEAL CARDS
  socket.on('dealCards', async (data) => {
    const { gameId, userId } = data;

    try {
      const game = await SrmGame.findById(gameId);
      if (!game) return;

      // FIX: Verify the user is the dealer
      if (!userId || game.dealer.toString() !== userId) {
        socket.emit('betError', { message: 'Only the dealer can deal cards.' });
        return;
      }

      // FIX: Only allow dealing when round is in betting status
      if (game.roundStatus !== 'betting') {
        socket.emit('betError', { message: 'Cards have already been dealt for this round.' });
        return;
      }

      const deck = getShuffledDeckOf54();
      const chosenCards = deck.slice(0, 3);

      // Set roundStatus = "resultsPending"
      game.dealtCards = chosenCards;
      game.roundStatus = 'resultsPending';
      await game.save();

      // Send the three cards
      io.to(`srmGame_${gameId}`).emit('cardsDealt', {
        card1: chosenCards[0],
        card2: chosenCards[1],
        card3: chosenCards[2],
      });

      // Compute payouts
      await computePayouts(gameId, chosenCards, io);

      // FIX #1: After payouts are computed, set roundStatus to "results"
      game.roundStatus = 'results';
      await game.save();

      // (Optional) If you want to push fresh data to all clients:
      io.to(`srmGame_${gameId}`).emit('gameData', {
        roundStatus: game.roundStatus,
        dealtCards: game.dealtCards,
        bets: game.bets,
        players: await Promise.all(
          game.players.map(async (pId) => {
            const p = await User.findById(pId);
            return {
              userId: p._id.toString(),
              username: p.username,
              ticketBalance: p.ticketBalance,
              color: getOrAssignColor(p._id.toString())
            };
          })
        ),
      });

    } catch (err) {
      console.error('Error dealing cards:', err);
    }
  });

  // CLEAR ROUND
  socket.on('clearRound', async (data) => {
    const { gameId, userId } = data;
    try {
      const game = await SrmGame.findById(gameId);
      if (!game) return;

      // FIX: Verify the user is the dealer
      if (!userId || game.dealer.toString() !== userId) {
        socket.emit('betError', { message: 'Only the dealer can clear the round.' });
        return;
      }

      // FIX: Only allow clearing when round is in results status
      if (game.roundStatus !== 'results' && game.roundStatus !== 'resultsPending') {
        socket.emit('betError', { message: 'Cannot clear round during betting.' });
        return;
      }

      // Reset the round
      game.roundStatus = 'betting';
      game.dealtCards = [];
      game.bets = [];
      await game.save();

      // Notify all clients
      io.to(`srmGame_${gameId}`).emit('roundCleared');
    } catch (err) {
      console.error('Error clearing round:', err);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) removeUserColor(socket.userId);
    console.log('User disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});