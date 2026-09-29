const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { RefreshToken } = require('../models');
const ApiError = require('../utils/ApiError');

const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 15 * 1000; // tolerate near-simultaneous refreshes from several tabs

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Admin and customer sessions are fully separated: different JWT audience, cookie name and cookie path,
// so a token issued to one side can never be replayed against the other.
const SCOPES = Object.freeze({
  admin: { audience: config.JWT_AUDIENCE, cookieName: config.REFRESH_COOKIE_NAME, cookiePath: '/api/admin/auth' },
  customer: { audience: config.JWT_CUSTOMER_AUDIENCE, cookieName: config.CUSTOMER_REFRESH_COOKIE_NAME, cookiePath: '/api/auth' },
});

function signAccessToken(user, scope = 'admin') {
  return jwt.sign(
    { sub: String(user._id), tv: user.tokenVersion || 0, typ: 'access' },
    config.JWT_ACCESS_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_ACCESS_EXPIRES_IN, issuer: config.JWT_ISSUER, audience: SCOPES[scope].audience },
  );
}

function verifyAccessToken(token, scope = 'admin') {
  return jwt.verify(token, config.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'], issuer: config.JWT_ISSUER, audience: SCOPES[scope].audience,
  });
}

function accessTokenTtlSeconds(token) {
  const decoded = jwt.decode(token);
  return decoded ? decoded.exp - Math.floor(Date.now() / 1000) : 0;
}

async function issueRefreshToken({ userId, familyId, rememberMe, ip, userAgent }) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const ttlDays = rememberMe ? config.REFRESH_TOKEN_REMEMBER_TTL_DAYS : config.REFRESH_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);
  await RefreshToken.create({
    userId,
    tokenHash: hashToken(raw),
    familyId: familyId || crypto.randomUUID(),
    rememberMe: Boolean(rememberMe),
    expiresAt,
    createdByIp: ip,
    userAgent: (userAgent || '').slice(0, 400),
  });
  return { raw, expiresAt, rememberMe: Boolean(rememberMe) };
}

/**
 * Validates and rotates a refresh token. Returns { stored, next } where next is the new raw token.
 * Detects reuse of an already-rotated token and revokes the entire token family.
 */
async function rotateRefreshToken(raw, { ip, userAgent }) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) throw ApiError.unauthorized('REFRESH_INVALID', 'Session expired, please sign in again');
  const stored = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
  if (!stored) throw ApiError.unauthorized('REFRESH_INVALID', 'Session expired, please sign in again');

  if (stored.revokedAt) {
    const recentlyRotated = stored.revokedReason === 'ROTATED' && Date.now() - stored.revokedAt.getTime() < ROTATION_GRACE_MS;
    if (recentlyRotated) {
      // Another tab refreshed a moment ago; the browser already holds the new cookie. Client retries once.
      throw ApiError.unauthorized('REFRESH_RACE', 'Session was refreshed concurrently, retry');
    }
    await RefreshToken.updateMany({ familyId: stored.familyId, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' });
    throw ApiError.unauthorized('REFRESH_REUSED', 'Session invalidated for security reasons, please sign in again');
  }
  if (stored.expiresAt <= new Date()) throw ApiError.unauthorized('REFRESH_EXPIRED', 'Session expired, please sign in again');

  // Atomic claim prevents two concurrent requests both rotating the same token.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: stored._id, revokedAt: null },
    { revokedAt: new Date(), revokedReason: 'ROTATED' },
    { new: true },
  );
  if (!claimed) throw ApiError.unauthorized('REFRESH_RACE', 'Session was refreshed concurrently, retry');

  const next = await issueRefreshToken({
    userId: stored.userId, familyId: stored.familyId, rememberMe: stored.rememberMe, ip, userAgent,
  });
  return { stored, next };
}

async function revokeByRaw(raw, reason = 'LOGOUT') {
  if (!raw || typeof raw !== 'string') return;
  const stored = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
  if (!stored) return;
  await RefreshToken.updateMany({ familyId: stored.familyId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}

async function revokeAllForUser(userId, reason = 'LOGOUT_ALL') {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}

function refreshCookieOptions(rememberMe, expiresAt, scope = 'admin') {
  const opts = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: SCOPES[scope].cookiePath,   // cookie is only ever sent to auth endpoints
    domain: config.COOKIE_DOMAIN,
  };
  if (rememberMe && expiresAt) opts.expires = expiresAt; // otherwise a session cookie
  return opts;
}

function setRefreshCookie(res, { raw, expiresAt, rememberMe }, scope = 'admin') {
  res.cookie(SCOPES[scope].cookieName, raw, refreshCookieOptions(rememberMe, expiresAt, scope));
}

function clearRefreshCookie(res, scope = 'admin') {
  const { expires, ...opts } = refreshCookieOptions(false, undefined, scope);
  res.clearCookie(SCOPES[scope].cookieName, opts);
}

const refreshCookieName = (scope = 'admin') => SCOPES[scope].cookieName;

module.exports = {
  signAccessToken, verifyAccessToken, accessTokenTtlSeconds,
  issueRefreshToken, rotateRefreshToken, revokeByRaw, revokeAllForUser,
  setRefreshCookie, clearRefreshCookie, refreshCookieName, hashToken,
};
