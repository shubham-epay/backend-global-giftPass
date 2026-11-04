const config = require('./src/config/env');
const { connectDB, disconnectDB } = require('./src/config/db');
const app = require('./src/app');
const paymentReconciler = require('./src/services/paymentReconciler');

let server;

async function start() {
  await connectDB();
  server = app.listen(config.PORT, () => {
    console.log(`[api] Global Gift Pass admin API listening on :${config.PORT} (${config.NODE_ENV})`);
    for (const e of Object.values(config.synrapay.environments).filter((x) => x.enabled)) {
      console.log(`[api] SynraPay ${e.id} webhook: ${e.webhookUrl || `<public api host>${e.webhookPath}`} (register in the ${e.label} dashboard)`);
    }
  });
  // Keeps payments/orders in step with SynraPay via Get Status, with or without webhooks.
  paymentReconciler.start();
}

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down gracefully...`);
  paymentReconciler.stop();
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
