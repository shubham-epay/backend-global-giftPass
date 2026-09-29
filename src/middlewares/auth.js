const jwt = require('jsonwebtoken');
const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../services/token.service');
const { SUPER } = require('../constants/permissions');

/**
 * Verifies the Bearer access token, then re-checks the user in the DB on every request
 * so that deactivation, role changes and "logout everywhere" take effect immediately.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('TOKEN_MISSING', 'Authentication required');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('TOKEN_EXPIRED', 'Access token expired');
      throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');
    }
    if (payload.typ !== 'access') throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');

    const user = await User.findById(payload.sub)
      .select('+tokenVersion name email type status roleId')
      .populate('roleId', 'name permissions isSystem')
      .lean();

    if (!user || user.type !== 'ADMIN') throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');
    if (user.status !== 'ACTIVE') throw ApiError.unauthorized('ACCOUNT_DISABLED', 'Your account is not active');
    if ((user.tokenVersion || 0) !== payload.tv) throw ApiError.unauthorized('TOKEN_REVOKED', 'Session was revoked, please sign in again');
    if (!user.roleId) throw ApiError.forbidden('No role is assigned to your account');

    req.user = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: { _id: user.roleId._id, name: user.roleId.name, isSystem: user.roleId.isSystem },
      permissions: new Set(user.roleId.permissions || []),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Customer (storefront) equivalent of authenticate. Tokens carry the customer audience, so admin
 * tokens are rejected here and customer tokens are rejected on /api/admin.
 */
async function authenticateCustomer(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('TOKEN_MISSING', 'Authentication required');

    let payload;
    try {
      payload = verifyAccessToken(token, 'customer');
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw ApiError.unauthorized('TOKEN_EXPIRED', 'Access token expired');
      throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');
    }
    if (payload.typ !== 'access') throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');

    const user = await User.findById(payload.sub).select('+tokenVersion name email phone type status').lean();
    if (!user || user.type !== 'CUSTOMER') throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid access token');
    if (user.status !== 'ACTIVE') throw ApiError.unauthorized('ACCOUNT_DISABLED', 'Your account is not active');
    if ((user.tokenVersion || 0) !== payload.tv) throw ApiError.unauthorized('TOKEN_REVOKED', 'Session was revoked, please sign in again');

    req.user = { _id: user._id, name: user.name, email: user.email, phone: user.phone };
    next();
  } catch (err) {
    next(err);
  }
}

const hasPermission = (perms, p) => perms.has(SUPER) || perms.has(p);

/** Requires the user to hold AT LEAST ONE of the listed permissions. */
const authorize = (...required) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (required.length === 0 || required.some((p) => hasPermission(req.user.permissions, p))) return next();
  return next(ApiError.forbidden());
};

module.exports = { authenticate, authenticateCustomer, authorize, hasPermission };
