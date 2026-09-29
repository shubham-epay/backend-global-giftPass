const config = require('./src/config/env');
const { connectDB, disconnectDB } = require('./src/config/db');
const app = require('./src/app');

let server;

async function start() {
  await connectDB();
  server = app.listen(config.PORT, () => {
    console.log(`[api] Global Gift Pass admin API listening on :${config.PORT} (${config.NODE_ENV})`);
  });
}

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down gracefully...`);
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDB();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[api] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[api] Uncaught exception:', err);
  process.exit(1);
});

start().catch((err) => {
  console.error('[api] Failed to start:', err.message);
  process.exit(1);
});
