const rateLimit = require('express-rate-limit');

const handler = (req, res, _next, options) => res.status(options.statusCode).json({
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', requestId: req.id },
});

const common = { standardHeaders: 'draft-7', legacyHeaders: false, handler };

module.exports = {
  apiLimiter: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 1000 }),
  loginLimiter: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true }),
  refreshLimiter: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 120 }),
  sensitiveLimiter: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 30 }),
};
