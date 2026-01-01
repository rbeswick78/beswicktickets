const mongoose = require('mongoose');
require('dotenv').config();

// Use env variable or fallback to local default
const dbURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/your-database-name';

mongoose.connect(dbURI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('Connection error:', err));

const db = mongoose.connection;

db.on('error', console.error.bind(console, 'Connection error:'));
db.once('open', function () {
  // Connection successful
});

module.exports = db;
