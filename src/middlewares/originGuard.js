const config = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * CSRF defence for the cookie-authenticated endpoints (refresh / logout).
 * Browsers always send Origin on cross-origin and same-origin POSTs; we require it
 * in production and require it to be on the allow-list.
 */
module.exports = (req, _res, next) => {
  const origin = req.get('origin');
  if (!origin) {
    if (config.isProd) return next(ApiError.forbidden('Origin header required'));
    return next();
  }
  if (!config.corsOrigins.includes(origin)) return next(ApiError.forbidden('Origin not allowed'));
  return next();
};
