const { authenticateCustomer } = require('./auth');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Cart and checkout work for guests and signed-in customers alike.
 *  - A Bearer token, when sent, must be valid (so an expired token still triggers the client refresh).
 *  - Guests identify their cart with the X-Cart-Token header (issued by the API on first add).
 * Sets req.user (signed in) and/or req.cartToken (guest cart handle, possibly to merge on sign-in).
 */
module.exports = function cartOwner(req, res, next) {
  const raw = req.get('x-cart-token');
  req.cartToken = raw && TOKEN_RE.test(raw) ? raw : null;
  res.set('Cache-Control', 'private, no-store');
  if (req.get('authorization')) return authenticateCustomer(req, res, next);
  return next();
};
