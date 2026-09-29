const express = require('express');
const validate = require('../../middlewares/validate');
const originGuard = require('../../middlewares/originGuard');
const { authenticateCustomer } = require('../../middlewares/auth');
const { loginLimiter, refreshLimiter, sensitiveLimiter } = require('../../middlewares/rateLimiters');
const { idParams } = require('../../validators/common');
const v = require('../../validators/customer.validators');

const auth = require('../../controllers/customer/auth.controller');
const catalog = require('../../controllers/customer/catalog.controller');
const cart = require('../../controllers/customer/cart.controller');
const orders = require('../../controllers/customer/order.controller');
const account = require('../../controllers/customer/account.controller');

/**
 * Customer storefront API, mounted at /api.
 * Public: catalogue browsing. Everything personal requires a customer access token (Bearer).
 */
const router = express.Router();

// ---------------- Auth ----------------
router.post('/auth/register', loginLimiter, validate({ body: v.register }), auth.register);
router.post('/auth/login', loginLimiter, validate({ body: v.login }), auth.login);
router.post('/auth/refresh', refreshLimiter, originGuard, auth.refresh);
router.post('/auth/logout', originGuard, auth.logout);

// ---------------- Public catalogue ----------------
router.get('/home', catalog.home);
router.get('/banners', validate({ query: v.bannerQuery }), catalog.banners);
router.get('/featured-products', validate({ query: v.limitQuery }), catalog.featuredProducts);
router.get('/categories', catalog.categories);
router.get('/categories/:slug/products', validate({ params: v.slugParams, query: v.productListQuery }), catalog.categoryProducts);
router.get('/products', validate({ query: v.productListQuery }), catalog.products);
router.get('/products/:slug', validate({ params: v.slugParams }), catalog.productDetail);
router.get('/search', validate({ query: v.searchQuery }), catalog.search);

// ---------------- Signed-in customer ----------------
// Attached per route (not router.use) so unknown /api paths still answer 404 rather than 401.
const noStore = (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
const personal = [authenticateCustomer, noStore];

router.post('/auth/change-password', ...personal, sensitiveLimiter, validate({ body: v.changePassword }), auth.changePassword);

// Cart
router.get('/cart', ...personal, cart.getCart);
router.post('/cart', ...personal, validate({ body: v.cartAdd }), cart.addItem);
router.delete('/cart', ...personal, cart.clearCart);
router.patch('/cart/:itemId', ...personal, validate({ params: v.itemIdParams, body: v.cartUpdate }), cart.updateItem);
router.delete('/cart/:itemId', ...personal, validate({ params: v.itemIdParams }), cart.removeItem);

// Wishlist
router.get('/wishlist', ...personal, cart.getWishlist);
router.post('/wishlist', ...personal, validate({ body: v.wishlistAdd }), cart.addToWishlist);
router.delete('/wishlist/:productId', ...personal, validate({ params: v.productIdParams }), cart.removeFromWishlist);

// Checkout
router.post('/checkout/apply-coupon', ...personal, validate({ body: v.applyCoupon }), orders.applyCoupon);
router.delete('/checkout/apply-coupon', ...personal, orders.removeCoupon);
router.post('/checkout', ...personal, sensitiveLimiter, validate({ body: v.checkout }), orders.checkout);

// Orders
router.get('/orders', ...personal, validate({ query: v.orderListQuery }), orders.listOrders);
router.get('/orders/:id', ...personal, validate({ params: idParams }), orders.getOrder);

// Profile & addresses
router.get('/profile', ...personal, account.getProfile);
router.put('/profile', ...personal, validate({ body: v.profileUpdate }), account.updateProfile);
router.get('/addresses', ...personal, account.listAddresses);
router.post('/addresses', ...personal, validate({ body: v.address }), account.addAddress);
router.put('/addresses/:id', ...personal, validate({ params: idParams, body: v.addressUpdate }), account.updateAddress);
router.delete('/addresses/:id', ...personal, validate({ params: idParams }), account.removeAddress);

// Vouchers
router.get('/my-vouchers', ...personal, validate({ query: v.voucherListQuery }), account.myVouchers);

module.exports = router;
