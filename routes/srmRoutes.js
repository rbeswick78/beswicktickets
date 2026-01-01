const express = require('express');
const router = express.Router();
const ensureAuthenticated = require('../middleware/auth');
const SrmGame = require('../models/SrmGame');

// GET /srm — Show the choose-role page (dealer or player)
router.get('/', ensureAuthenticated, (req, res) => {
  res.render('srm/chooseRole');
});

// POST /srm/create-game — create a new game with a unique 3-digit code
router.post('/create-game', ensureAuthenticated, async (req, res) => {
  try {
    let code;
    do {
      code = (Math.floor(Math.random() * 900) + 100).toString();
    } while (await SrmGame.findOne({ code, status: 'active' }));

    const game = new SrmGame({
      code,
      dealer: req.user._id,
    });
    await game.save();

    res.json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /srm/join-as-player — user joins a game with a specific code
router.post('/join-as-player', ensureAuthenticated, async (req, res) => {
  try {
    const { gameCode } = req.body;
    const game = await SrmGame.findOne({ code: gameCode, status: 'active' });
    if (!game) {
      return res.status(404).send('Game not found');
    }
    if (!game.players.includes(req.user._id)) {
      game.players.push(req.user._id);
      await game.save();
    }
    res.redirect(`/srm/game/${game._id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

// GET /srm/dealer — show list of active games, allow dealer switch
router.get('/dealer', ensureAuthenticated, async (req, res) => {
  try {
    const allActiveGames = await SrmGame.find({ status: 'active' }).populate('dealer');
    const activeGames = allActiveGames.filter(game => game.dealer);
    res.render('srm/dealerLobby', { activeGames });
  } catch (error) {
    console.error('Error retrieving active games:', error);
    res.status(500).send('Error retrieving active games');
  }
});

// POST /srm/join-game-dealer — replace existing dealer with current user
router.post('/join-game-dealer', ensureAuthenticated, async (req, res) => {
  try {
    const { gameId } = req.body;
    const game = await SrmGame.findById(gameId).populate('dealer');
    if (!game) {
      return res.status(404).send('Game not found');
    }

    game.dealer = req.user._id;
    await game.save();

    res.redirect(`/srm/game/${game._id}`);
  } catch (error) {
    console.error('Error joining game as dealer:', error);
    res.status(500).send('Error joining game as dealer');
  }
});

// GET /srm/player — show a list of active games
router.get('/player', ensureAuthenticated, async (req, res) => {
  try {
    const activeGames = await SrmGame.find({ status: 'active' }).populate('dealer');
    res.render('srm/playerLobby', { activeGames });
  } catch (error) {
    console.error('Error retrieving active games:', error);
    res.status(500).send('Error retrieving active games');
  }
});

// GET /srm/game/:gameId — show the main game board
router.get('/game/:gameId', ensureAuthenticated, async (req, res) => {
  try {
    const { gameId } = req.params;
    const game = await SrmGame.findById(gameId).populate('dealer').populate('players');

    if (!game || game.status === 'ended') {
      return res.status(404).send('Game not found or has ended');
    }

    res.render('srm/gameBoard', {
      game,
      currentUserId: req.user._id.toString(),
      currentUserBalance: req.user.ticketBalance
    });
  } catch (error) {
    console.error('Error loading game board:', error);
    res.status(500).send('Server error');
  }
});

module.exports = router;