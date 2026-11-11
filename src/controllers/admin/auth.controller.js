const config = require('../../config/env');
const { User } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const tokens = require('../../services/token.service');
const { audit } = require('../../services/audit.service');

const bcrypt = require('bcryptjs');

// Used to equalise response time when the email does not exist (prevents user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

function serializeUser(user, role) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    lastLoginAt: user.lastLoginAt,
    role: role ? { _id: role._id, name: role.name, isSystem: role.isSystem, permissions: role.permissions } : null,
  };
}

async function sessionResponse(res, user, role, refresh) {
  tokens.setRefreshCookie(res, refresh);
  const accessToken = tokens.signAccessToken(user);
  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: tokens.accessTokenTtlSeconds(accessToken),
    user: serializeUser(user, role),
  };
}

const login = asyncHandler(async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const invalid = () => ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');

  const user = await User.findOne({ email, type: 'ADMIN' })
    .select('+passwordHash +tokenVersion +failedLoginAttempts +lockUntil')
    .populate('roleId', 'name permissions isSystem');

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    audit(req, { action: 'auth.login.failed', resource: 'auth', summary: `Unknown email ${email}`, actor: { email } });
    throw invalid();
  }

  if (user.isLocked()) {
    audit(req, { action: 'auth.login.locked', resource: 'auth', resourceId: user._id, actor: user });
    throw new ApiError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${user.lockUntil.toISOString()}`);
  }

  const ok = await user.comparePassword(password);
  if (!ok) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
      update.lockUntil = new Date(Date.now() + config.LOGIN_LOCK_MINUTES * 60 * 1000);
      update.failedLoginAttempts = 0;
    }
    await User.updateOne({ _id: user._id }, update);
    audit(req, { action: 'auth.login.failed', resource: 'auth', resourceId: user._id, actor: user, summary: `Attempt ${attempts}` });
    throw invalid();
  }

  if (user.status !== 'ACTIVE') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Your account is not active. Contact an administrator.');
  if (!user.roleId) throw new ApiError(403, 'NO_ROLE', 'No role is assigned to your account. Contact an administrator.');

  await User.updateOne({ _id: user._id }, {
    failedLoginAttempts: 0, $unset: { lockUntil: 1 }, lastLoginAt: new Date(), lastLoginIp: req.ip,
  });

  const refresh = await tokens.issueRefreshToken({ userId: user._id, rememberMe, ip: req.ip, userAgent: req.get('user-agent') });
  audit(req, { action: 'auth.login', resource: 'auth', resourceId: user._id, actor: user });
  res.json({ success: true, data: await sessionResponse(res, user, user.roleId, refresh) });
});

const refresh = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[config.REFRESH_COOKIE_NAME];
  try {
    const { stored, next } = await tokens.rotateRefreshToken(raw, { ip: req.ip, userAgent: req.get('user-agent') });
    const user = await User.findById(stored.userId).select('+tokenVersion').populate('roleId', 'name permissions isSystem');
    if (!user || user.type !== 'ADMIN' || user.status !== 'ACTIVE' || !user.roleId) {
      await tokens.revokeByRaw(next.raw, 'ADMIN_ACTION');
      throw ApiError.unauthorized('ACCOUNT_DISABLED', 'Your account is not active');
    }
    res.json({ success: true, data: await sessionResponse(res, user, user.roleId, next) });
  } catch (err) {
    if (err.code !== 'REFRESH_RACE') tokens.clearRefreshCookie(res);
    if (err.code === 'REFRESH_REUSED') audit(req, { action: 'auth.refresh.reuse_detected', resource: 'auth' });
    throw err;
  }
});

const logout = asyncHandler(async (req, res) => {
  await tokens.revokeByRaw(req.cookies?.[config.REFRESH_COOKIE_NAME], 'LOGOUT');
  tokens.clearRefreshCookie(res);
  res.json({ success: true, data: { loggedOut: true } });
});

const logoutAll = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  await tokens.revokeAllForUser(req.user._id, 'LOGOUT_ALL');
  tokens.clearRefreshCookie(res);
  audit(req, { action: 'auth.logout_all', resource: 'auth', resourceId: req.user._id });
  res.json({ success: true, data: { loggedOut: true } });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('roleId', 'name permissions isSystem');
  res.json({ success: true, data: serializeUser(user, user.roleId) });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+passwordHash +tokenVersion').populate('roleId', 'name permissions isSystem');
  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
  }
  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.tokenVersion += 1;
  await user.save();
  await tokens.revokeAllForUser(user._id, 'PASSWORD_CHANGED');
  audit(req, { action: 'auth.password_changed', resource: 'users', resourceId: user._id });

  // Keep the current device signed in with a fresh session.
  const refresh = await tokens.issueRefreshToken({ userId: user._id, rememberMe: false, ip: req.ip, userAgent: req.get('user-agent') });
  res.json({ success: true, data: await sessionResponse(res, user, user.roleId, refresh) });
});

module.exports = { login, refresh, logout, logoutAll, me, changePassword };
