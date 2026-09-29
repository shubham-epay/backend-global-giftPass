const mongoose = require('mongoose');

/**
 * Runs fn inside a MongoDB transaction (Atlas / replica set).
 * Falls back to non-transactional execution on standalone servers (local dev only).
 */
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } catch (err) {
    const unsupported = err && (err.code === 20 || /Transaction numbers are only allowed/i.test(err.message));
    if (unsupported) return fn(undefined);
    throw err;
  } finally {
    await session.endSession();
  }
}
module.exports = { runInTransaction };
