const express = require('express');
const validate = require('../../middlewares/validate');
const originGuard = require('../../middlewares/originGuard');
const { authenticate, authorize } = require('../../middlewares/auth');
const { loginLimiter, refreshLimiter, sensitiveLimiter } = require('../../middlewares/rateLimiters');
const { idParams, listQuery } = require('../../validators/common');
const v = require('../../validators/admin.validators');
const { resourceRouter } = require('./resource');

const auth = require('../../controllers/admin/auth.controller');
const users = require('../../controllers/admin/user.controller');
const roles = require('../../controllers/admin/role.controller');
const catalog = require('../../controllers/admin/catalog.controller');
const cms = require('../../controllers/admin/cms.controller');
const orders = require('../../controllers/admin/order.controller');
const vouchers = require('../../controllers/admin/voucher.controller');
const dashboard = require('../../controllers/admin/dashboard.controller');
const misc = require('../../controllers/admin/misc.controller');
const productImport = require('../../controllers/admin/productImport.controller');

const router = express.Router();

// ---------------- Auth (public + cookie based) ----------------
router.post('/auth/login', loginLimiter, validate({ body: v.login }), auth.login);
router.post('/auth/refresh', refreshLimiter, originGuard, auth.refresh);
router.post('/auth/logout', originGuard, auth.logout);

// ---------------- Everything below requires a valid access token ----------------
router.use(authenticate);

router.get('/auth/me', auth.me);
router.post('/auth/logout-all', auth.logoutAll);
router.post('/auth/change-password', sensitiveLimiter, validate({ body: v.changePassword }), auth.changePassword);
router.get('/meta', misc.meta);

// Pickers (e.g. category dropdown on product form) need read access across modules.
const CATALOG_PICKERS = ['products.read', 'products.create', 'products.update', 'giftBoxes.manage', 'coupons.read', 'coupons.create', 'coupons.update', 'cms.manage'];

router.get('/dashboard', authorize('dashboard.read'), dashboard.summary);
router.get('/dashboard/summary', authorize('dashboard.read'), dashboard.summary);

// Users
router.get('/users', authorize('users.manage'), validate({ query: listQuery }), users.list);
router.get('/users/:id', authorize('users.manage'), validate({ params: idParams }), users.getOne);
router.post('/users', authorize('users.manage'), validate({ body: v.userCreate }), users.create);
router.patch('/users/:id', authorize('users.manage'), validate({ params: idParams, body: v.userUpdate }), users.update);
router.post('/users/:id/reset-password', authorize('users.manage'), sensitiveLimiter, validate({ params: idParams, body: v.resetPassword }), users.resetPassword);
router.post('/users/:id/revoke-sessions', authorize('users.manage'), validate({ params: idParams }), users.revokeSessions);
router.delete('/users/:id', authorize('users.manage'), validate({ params: idParams }), users.remove);

// Roles & permissions
router.get('/permissions', authorize('roles.manage', 'users.manage'), roles.permissions);
router.get('/roles', authorize('roles.manage', 'users.manage'), validate({ query: listQuery }), roles.list);
router.get('/roles/:id', authorize('roles.manage', 'users.manage'), validate({ params: idParams }), roles.getOne);
router.post('/roles', authorize('roles.manage'), validate({ body: v.roleCreate }), roles.create);
router.patch('/roles/:id', authorize('roles.manage'), validate({ params: idParams, body: v.roleUpdate }), roles.update);
router.delete('/roles/:id', authorize('roles.manage'), validate({ params: idParams }), roles.remove);

// Catalogue
router.use('/categories', resourceRouter(catalog.categories, v.category, {
  read: ['categories.manage', ...CATALOG_PICKERS], create: ['categories.manage'], update: ['categories.manage'], delete: ['categories.manage'],
}));
router.use('/partners', resourceRouter(catalog.partners, v.partner, {
  read: ['partners.manage', ...CATALOG_PICKERS, 'vouchers.update'], create: ['partners.manage'], update: ['partners.manage'], delete: ['partners.manage'],
}));
// Bulk CSV import (registered before the /products resource router so "import" is not taken as an :id)
const csvBody = express.text({ type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'], limit: '10mb' });
router.get('/products/import/template', authorize('products.create'), productImport.template);
router.get('/products/import/fields', authorize('products.create'), productImport.fields);
router.post('/products/import', authorize('products.create'), csvBody, validate({ query: v.productImportQuery }), productImport.importProducts);
router.use('/products', resourceRouter(catalog.products, v.product, {
  read: [...CATALOG_PICKERS, 'vouchers.create'], create: ['products.create'], update: ['products.update'], delete: ['products.delete'],
}));
router.use('/gift-boxes', resourceRouter(catalog.giftBoxes, v.giftBox, {
  read: ['giftBoxes.manage', 'vouchers.create'], create: ['giftBoxes.manage'], update: ['giftBoxes.manage'], delete: ['giftBoxes.manage'],
}));
router.use('/coupons', resourceRouter(catalog.coupons, v.coupon, {
  read: ['coupons.read', 'coupons.create', 'coupons.update'], create: ['coupons.create'], update: ['coupons.update'], delete: ['coupons.delete'],
}));

// Orders
router.get('/orders', authorize('orders.read', 'vouchers.create'), validate({ query: listQuery }), orders.list);
router.get('/orders/:id', authorize('orders.read'), validate({ params: idParams }), orders.getOne);
router.patch('/orders/:id/status', authorize('orders.updateStatus'), validate({ params: idParams, body: v.orderStatusUpdate }), orders.updateStatus);

// Vouchers
router.get('/vouchers', authorize('vouchers.read'), validate({ query: listQuery }), vouchers.list);
router.get('/vouchers/:id', authorize('vouchers.read'), validate({ params: idParams }), vouchers.getOne);
router.post('/vouchers/create', authorize('vouchers.create'), validate({ body: v.voucherCreate }), vouchers.create);
router.post('/vouchers', authorize('vouchers.create'), validate({ body: v.voucherCreate }), vouchers.create);
router.patch('/vouchers/:id', authorize('vouchers.update'), validate({ params: idParams, body: v.voucherUpdate }), vouchers.update);
router.patch('/vouchers/:id/status', authorize('vouchers.update'), validate({ params: idParams, body: v.voucherStatusUpdate }), vouchers.updateStatus);

// CMS
const cmsPerms = { read: ['cms.manage'], create: ['cms.manage'], update: ['cms.manage'], delete: ['cms.manage'] };
router.use('/banners', resourceRouter(cms.banners, v.banner, cmsPerms));
router.use('/collections', resourceRouter(cms.collections, v.collection, cmsPerms));
router.use('/blogs', resourceRouter(cms.blogs, v.blog, cmsPerms));
router.use('/faqs', resourceRouter(cms.faqs, v.faq, cmsPerms));

// Audit log
router.get('/audit-logs', authorize('auditLogs.read'), validate({ query: listQuery }), misc.auditLogs);

module.exports = router;
