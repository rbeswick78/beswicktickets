const mongoose = require('mongoose');
// Updated to use the correct database name found in your config/db.js
const uri = 'mongodb://localhost:27017/your-database-name';

// Define minimal schemas needed for cleanup
const SrmGame = mongoose.model('srmGame', new mongoose.Schema({
  code: String,
  dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: String
}));

const User = mongoose.model('User', new mongoose.Schema({
  username: String
}));

async function cleanup() {
  try {
    console.log(`Connecting to ${uri}...`);
    await mongoose.connect(uri);
    console.log('Connected.');

    // Find all active games and populate dealer
    const games = await SrmGame.find({ status: 'active' }).populate('dealer');
    console.log(`Found ${games.length} active games.`);

    let deletedCount = 0;
    for (const game of games) {
      if (!game.dealer) {
        console.log(`[FIX] Game ${game.code} (ID: ${game._id}) has no valid dealer. Deleting...`);
        await SrmGame.deleteOne({ _id: game._id });
        deletedCount++;
      } else {
        console.log(`[OK] Game ${game.code} dealer is ${game.dealer.username}`);
      }
    }

    console.log(`Done. Deleted ${deletedCount} broken games.`);
  } catch (e) {
    console.error('Error:', e);
  } finally {
    mongoose.connection.close();
  }
}

cleanup();
