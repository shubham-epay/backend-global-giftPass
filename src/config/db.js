const mongoose = require('mongoose');
const config = require('./env');

mongoose.set('strictQuery', true);
mongoose.set('toJSON', { virtuals: true, versionKey: false, transform: (_d, ret) => { delete ret.id; return ret; } });
mongoose.set('toObject', { virtuals: true, versionKey: false });

async function connectDB() {
  mongoose.connection.on('connected', () => console.log(`[db] Connected to MongoDB (${config.MONGODB_DB_NAME})`));
  mongoose.connection.on('error', (err) => console.error('[db] Connection error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('[db] Disconnected'));

  await mongoose.connect(config.MONGODB_URI, {
    dbName: config.MONGODB_DB_NAME,
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    // Index builds on a live production DB should be deliberate: run `npm run db:indexes`.
    autoIndex: !config.isProd,
  });
}

async function disconnectDB() {
  await mongoose.connection.close();
}

module.exports = { connectDB, disconnectDB };
