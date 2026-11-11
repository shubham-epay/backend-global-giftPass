/* Creates / updates all indexes declared in the schemas. Run on deploy: npm run db:indexes */
const mongoose = require('mongoose');
const config = require('../config/env');
const models = require('../models');

(async () => {
  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB_NAME, autoIndex: false });
  for (const [name, Model] of Object.entries(models)) {
    await Model.createCollection().catch(() => {});
    await Model.createIndexes();
    console.log(`[indexes] ${name} ✓`);
  }
  await mongoose.disconnect();
  console.log('[indexes] done');
})().catch(async (err) => {
  console.error('[indexes] failed:', err.message);
  await mongoose.disconnect();
  process.exit(1);
});
