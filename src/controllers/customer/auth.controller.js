const bcrypt = require('bcryptjs');
const config = require('../../config/env');
const { User } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const tokens = require('../../services/token.service');
const { audit } = require('../../services/audit.service');

const SCOPE = 'customer';
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

const serializeCustomer = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  avatarUrl: user.avatarUrl,
  createdAt: user.createdAt,
});

function sessionResponse(res, user, refresh) {
  tokens.setRefreshCookie(res, refresh, SCOPE);
  const accessToken = tokens.signAccessToken(user, SCOPE);
  return { accessToken, tokenType: 'Bearer', expiresIn: tokens.accessTokenTtlSeconds(accessToken), user: serializeCustomer(user) };
}

const issue = (req, user, rememberMe) => tokens.issueRefreshToken({ userId: user._id, rememberMe, ip: req.ip, userAgent: req.get('user-agent') });

const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (await User.exists({ email })) {
    throw ApiError.conflict('An account with this email already exists', [{ path: 'email', message: 'Already registered' }]);
  }
  const user = await User.create({
    name, email, phone: phone || undefined, type: 'CUSTOMER', status: 'ACTIVE',
    passwordHash: await User.hashPassword(password),
  });
  audit(req, { action: 'customer.register', resource: 'customers', resourceId: user._id, actor: user });
  const refresh = await issue(req, user, false);
  res.status(201).json({ success: true, data: sessionResponse(res, user, refresh) });
});

const login = asyncHandler(async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const invalid = () => ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');

  const user = await User.findOne({ email, type: 'CUSTOMER' }).select('+passwordHash +tokenVersion +failedLoginAttempts +lockUntil');
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw invalid();
  }
  if (user.isLocked()) {
    throw new ApiError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${user.lockUntil.toISOString()}`);
  }
  if (!(await user.comparePassword(password))) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
      update.lockUntil = new Date(Date.now() + config.LOGIN_LOCK_MINUTES * 60 * 1000);
      update.failedLoginAttempts = 0;
    }
    await User.updateOne({ _id: user._id }, update);
    throw invalid();
  }
  if (user.status !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Your account is not active. Contact support.');

  await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, $unset: { lockUntil: 1 }, lastLoginAt: new Date(), lastLoginIp: req.ip });
  const refresh = await issue(req, user, rememberMe);
  res.json({ success: true, data: sessionResponse(res, user, refresh) });
});

const refresh = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[tokens.refreshCookieName(SCOPE)];
  try {
    const { stored, next } = await tokens.rotateRefreshToken(raw, { ip: req.ip, userAgent: req.get('user-agent') });
    const user = await User.findById(stored.userId).select('+tokenVersion');
    if (!user || user.type !== 'CUSTOMER' || user.status !== 'ACTIVE') {
      await tokens.revokeByRaw(next.raw, 'ADMIN_ACTION');
      throw ApiError.unauthorized('ACCOUNT_DISABLED', 'Your account is not active');
    }
    res.json({ success: true, data: sessionResponse(res, user, next) });
  } catch (err) {
    if (err.code !== 'REFRESH_RACE') tokens.clearRefreshCookie(res, SCOPE);
    throw err;
  }
});

const logout = asyncHandler(async (req, res) => {
  await tokens.revokeByRaw(req.cookies?.[tokens.refreshCookieName(SCOPE)], 'LOGOUT');
  tokens.clearRefreshCookie(res, SCOPE);
  res.json({ success: true, data: { loggedOut: true } });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+passwordHash +tokenVersion');
  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
  }
  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.tokenVersion += 1;
  await user.save();
  await tokens.revokeAllForUser(user._id, 'PASSWORD_CHANGED');
  const next = await issue(req, user, false);
  res.json({ success: true, data: sessionResponse(res, user, next) });
});

module.exports = { register, login, refresh, logout, changePassword, serializeCustomer };
