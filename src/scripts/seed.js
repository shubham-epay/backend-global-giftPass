/**
 * Idempotent seed:
 *  - creates every collection + index
 *  - system Super Admin role + 4 working roles
 *  - first super admin user (from SEED_ADMIN_* env)
 *  - two starter categories and the WELCOME25 example coupon
 * Safe to run repeatedly.
 */
const mongoose = require('mongoose');
const config = require('../config/env');
const models = require('../models');
const { SUPER } = require('../constants/permissions');

const { Role, User, Category, Coupon, Setting } = models;

const ROLES = [
  { name: 'Super Admin', description: 'Full access to everything. System role.', permissions: [SUPER], isSystem: true },
  { name: 'Catalogue Manager', description: 'Products, categories, partners, gift boxes and coupons.', permissions: [
    'dashboard.read', 'products.read', 'products.create', 'products.update', 'products.delete',
    'categories.manage', 'partners.manage', 'giftBoxes.manage', 'coupons.read', 'coupons.create', 'coupons.update'] },
  { name: 'Order Manager', description: 'Orders and vouchers.', permissions: [
    'dashboard.read', 'orders.read', 'orders.updateStatus', 'vouchers.read', 'vouchers.create', 'vouchers.update', 'products.read'] },
  { name: 'Content Editor', description: 'Banners, collections, blogs and FAQs.', permissions: ['cms.manage', 'products.read'] },
  { name: 'Support (read only)', description: 'Look up orders, vouchers and products.', permissions: [
    'dashboard.read', 'orders.read', 'vouchers.read', 'products.read', 'coupons.read'] },
];

(async () => {
  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB_NAME });
  console.log(`[seed] connected to ${config.MONGODB_DB_NAME}`);

  for (const [name, Model] of Object.entries(models)) {
    await Model.createCollection().catch(() => {});
    await Model.createIndexes();
    console.log(`[seed] collection + indexes: ${name}`);
  }

  const roles = {};
  for (const r of ROLES) {
    roles[r.name] = await Role.findOneAndUpdate(
      { name: r.name },
      { $setOnInsert: r },
      { upsert: true, new: true, collation: { locale: 'en', strength: 2 } },
    );
  }
  // Make sure the system role always keeps full access.
  await Role.updateOne({ _id: roles['Super Admin']._id }, { permissions: [SUPER], isSystem: true });
  console.log('[seed] roles ready');

  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password, SEED_ADMIN_NAME: name } = config;
  if (email && password) {
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) {
      console.log(`[seed] admin ${email} already exists, left unchanged`);
    } else {
      await User.create({
        name: name || 'Super Admin', email, type: 'ADMIN', status: 'ACTIVE',
        roleId: roles['Super Admin']._id, passwordHash: await User.hashPassword(password), passwordChangedAt: new Date(),
      });
      console.log(`[seed] created super admin ${email} — sign in and change the password immediately`);
    }
  } else {
    console.warn('[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set, no admin created');
  }

  const cats = {};
  for (const c of [
    { name: 'Spa & Wellness', slug: 'spa-wellness', status: 'ACTIVE', sortOrder: 1 },
    { name: 'Dining', slug: 'dining', status: 'ACTIVE', sortOrder: 2 },
  ]) {
    cats[c.slug] = await Category.findOneAndUpdate({ slug: c.slug }, { $setOnInsert: c }, { upsert: true, new: true });
  }

  await Coupon.findOneAndUpdate({ code: 'WELCOME25' }, {
    $setOnInsert: {
      title: 'Welcome 25% off', code: 'WELCOME25', discountType: 'PERCENTAGE', discountValue: 25,
      minimumOrderValue: 300, maximumDiscount: 200, validFrom: new Date('2026-10-01T00:00:00+04:00'),
      validTill: new Date('2026-12-31T23:59:59+04:00'), usageLimit: 1000, usagePerUser: 1,
      applicableCategories: [cats['spa-wellness']._id, cats.dining._id], applicableCities: ['Dubai', 'Abu Dhabi'],
      status: 'ACTIVE', description: 'First-order welcome discount',
    },
  }, { upsert: true });

  await Setting.findOneAndUpdate({ key: 'store.currency' }, { $setOnInsert: { key: 'store.currency', value: 'AED', isPublic: true } }, { upsert: true });
  await Setting.findOneAndUpdate({ key: 'store.vatRate' }, { $setOnInsert: { key: 'store.vatRate', value: 0.05, isPublic: true, description: 'UAE VAT' } }, { upsert: true });

  console.log('[seed] categories, WELCOME25 coupon and settings ready');
  await mongoose.disconnect();
  console.log('[seed] done');
})().catch(async (err) => {
  console.error('[seed] failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
