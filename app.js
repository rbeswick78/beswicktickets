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
const {
  createSerializer,
  handlePlayerBetBatch,
  handleDealCards,
  handleClearRound,
} = require('./services/srmGameHandlers');

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

// Global per-game serialization queue to prevent race conditions. dealCards, clearRound, and
// playerBetBatch all run through this so a deal/clear can never interleave with an in-flight
// bet batch. The money/state handlers live in services/srmGameHandlers.js (testable without a
// live MongoDB); here we just inject their collaborators.
const { runSerialized } = createSerializer();
const handlerDeps = {
  SrmGame,
  User,
  io,
  computePayouts,
  getShuffledDeckOf54,
  getOrAssignColor,
  runSerialized,
};

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

  // Batched Bet Handler (validate at the trust boundary, then commit inside the per-game queue)
  socket.on('playerBetBatch', (batchData) => {
    handlePlayerBetBatch(handlerDeps, socket, batchData);
  });

  // DEAL CARDS (serialized + atomic guarded transition)
  socket.on('dealCards', (data) => {
    handleDealCards(handlerDeps, socket, data);
  });

  // CLEAR ROUND (serialized + atomic guarded transition)
  socket.on('clearRound', (data) => {
    handleClearRound(handlerDeps, socket, data);
  });

  socket.on('disconnect', () => {
    if (socket.userId) removeUserColor(socket.userId);
    console.log('User disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});