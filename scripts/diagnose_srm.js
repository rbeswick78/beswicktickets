const mongoose = require('mongoose');
const SrmGame = require('../models/SrmGame');
const User = require('../models/User'); // Required for population

// Check if we're in a production environment or need to load local config
// Assuming standard mongoose connection or using the app's config if available.
// For this script, we'll try to require the db config, or fallback to env var.

const dbConfigPath = '../config/db';

async function runDiagnosis() {
  console.log('--- SRM Diagnosis Tool ---');

  // 1. Connect to Database
  try {
    // If the app uses a specific file to connect, we can require it.
    // However, config/db.js connects immediately upon require.
    require(dbConfigPath); 
    
    // Wait for connection to be ready
    if (mongoose.connection.readyState === 0) {
        console.log('Waiting for DB connection...');
        await new Promise(resolve => mongoose.connection.once('open', resolve));
    }
  } catch (err) {
    console.error('Could not load db config or connect:', err);
    console.log('Please ensure this script is run with the correct MONGO_URI environment variable if config/db.js is not sufficient.');
    process.exit(1);
  }

  console.log('Connected to Database.');

  // 2. Find Active Games
  try {
    const activeGames = await SrmGame.find({ status: 'active' }).populate('dealer');
    console.log(`Found ${activeGames.length} active games.`);

    let badGamesCount = 0;

    for (const game of activeGames) {
      const dealer = game.dealer;
      console.log(`Game Code: ${game.code} | ID: ${game._id}`);
      
      if (!dealer) {
        console.error(`  [ERROR] Dealer is MISSING (null). This causes the 500 error.`);
        console.log(`  To fix: Delete this game manually or via script.`);
        badGamesCount++;
      } else {
        console.log(`  Dealer: ${dealer.username} (${dealer._id}) - OK`);
      }
    }

    if (badGamesCount > 0) {
      console.log('---------------------------------------------------');
      console.log(`DIAGNOSIS: Found ${badGamesCount} broken games.`);
      console.log('These games have a status of "active" but no valid dealer user.');
      console.log('The application crashes when trying to display the dealer name.');
    } else {
      console.log('No broken active games found based on "missing dealer".');
    }

  } catch (err) {
    console.error('Error querying database:', err);
  } finally {
    mongoose.connection.close();
    process.exit(0);
  }
}

runDiagnosis();





