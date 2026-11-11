const mongoose = require('mongoose');
const { User, Role, Order } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex, isObjectId } = require('../../utils/helpers');
const { audit } = require('../../services/audit.service');
const tokens = require('../../services/token.service');
const { assertCanGrant } = require('./role.controller');

const PUBLIC_FIELDS = 'name email phone type roleId status avatarUrl lastLoginAt createdAt updatedAt';

async function loadRole(roleId) {
  const role = await Role.findById(roleId).lean();
  if (!role) throw new ApiError(422, 'INVALID_REFERENCE', 'Role not found', [{ path: 'roleId', message: 'Unknown role' }]);
  return role;
}

async function activeSuperAdminCount(excludeUserId) {
  const superRoles = await Role.find({ isSystem: true }).select('_id').lean();
  return User.countDocuments({
    type: 'ADMIN', status: 'ACTIVE', roleId: { $in: superRoles.map((r) => r._id) }, _id: { $ne: excludeUserId },
  });
}

/** An actor can only manage admins whose current role is within the actor's own permissions. */
async function assertCanManageAdmin(req, target) {
  if (target.type !== 'ADMIN' || !target.roleId) return;
  const role = await Role.findById(target.roleId).lean();
  if (role) assertCanGrant(req.user.permissions, role.permissions);
}

async function invalidateSessions(userId, reason) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await tokens.revokeAllForUser(userId, reason);
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, q, type = 'ADMIN', status, roleId } = req.query;
  const filter = {};
  if (['ADMIN', 'CUSTOMER'].includes(type)) filter.type = type;
  if (status) filter.status = String(status);
  if (roleId && isObjectId(roleId)) filter.roleId = new mongoose.Types.ObjectId(roleId);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).select(PUBLIC_FIELDS).populate('roleId', 'name isSystem').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
});

const getOne = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select(PUBLIC_FIELDS).populate('roleId', 'name permissions isSystem');
  if (!user) throw ApiError.notFound('User');
  res.json({ success: true, data: user });
});

const create = asyncHandler(async (req, res) => {
  const { password, roleId, ...rest } = req.body;
  const role = await loadRole(roleId);
  assertCanGrant(req.user.permissions, role.permissions);
  const user = await User.create({
    ...rest, type: 'ADMIN', roleId, passwordHash: await User.hashPassword(password),
    passwordChangedAt: new Date(), createdBy: req.user._id,
  });
  audit(req, { action: 'users.create', resource: 'users', resourceId: user._id, summary: `Created admin ${user.email} with role "${role.name}"` });
  res.status(201).json({ success: true, data: await User.findById(user._id).select(PUBLIC_FIELDS).populate('roleId', 'name isSystem') });
});

const update = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User');
  const isSelf = target._id.equals(req.user._id);
  const data = { ...req.body };

  if (target.type === 'CUSTOMER' && data.roleId) throw ApiError.badRequest('Customers cannot be assigned an admin role');
  if (target.type === 'ADMIN') {
    await assertCanManageAdmin(req, target);
    if (isSelf && (data.roleId || (data.status && data.status !== 'ACTIVE'))) {
      throw ApiError.forbidden('You cannot change your own role or deactivate yourself');
    }
    if (data.roleId && String(data.roleId) !== String(target.roleId)) {
      const newRole = await loadRole(data.roleId);
      assertCanGrant(req.user.permissions, newRole.permissions);
    }
    const currentRole = await Role.findById(target.roleId).lean();
    const losingSuper = currentRole?.isSystem && (
      (data.status && data.status !== 'ACTIVE') || (data.roleId && String(data.roleId) !== String(target.roleId)));
    if (losingSuper && (await activeSuperAdminCount(target._id)) === 0) {
      throw ApiError.conflict('At least one active Super Admin must remain');
    }
  }

  const securityChange = (data.roleId && String(data.roleId) !== String(target.roleId)) || (data.status && data.status !== target.status);
  const before = { name: target.name, phone: target.phone, roleId: target.roleId, status: target.status };
  target.set(data);
  await target.save();
  if (securityChange) await invalidateSessions(target._id, 'ADMIN_ACTION');

  audit(req, { action: 'users.update', resource: 'users', resourceId: target._id, summary: `Updated ${target.email}`, changes: { before, after: data } });
  res.json({ success: true, data: await User.findById(target._id).select(PUBLIC_FIELDS).populate('roleId', 'name isSystem') });
});

const resetPassword = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User');
  await assertCanManageAdmin(req, target);
  target.passwordHash = await User.hashPassword(req.body.newPassword);
  target.passwordChangedAt = new Date();
  await target.save();
  await invalidateSessions(target._id, 'PASSWORD_CHANGED');
  audit(req, { action: 'users.reset_password', resource: 'users', resourceId: target._id, summary: `Reset password for ${target.email}` });
  res.json({ success: true, data: { _id: target._id } });
});

const revokeSessions = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User');
  await assertCanManageAdmin(req, target);
  await invalidateSessions(target._id, 'ADMIN_ACTION');
  audit(req, { action: 'users.revoke_sessions', resource: 'users', resourceId: target._id, summary: `Signed ${target.email} out of all devices` });
  res.json({ success: true, data: { _id: target._id } });
});

const remove = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound('User');
  if (target._id.equals(req.user._id)) throw ApiError.forbidden('You cannot delete your own account');
  if (target.type === 'ADMIN') {
    await assertCanManageAdmin(req, target);
    const role = await Role.findById(target.roleId).lean();
    if (role?.isSystem && (await activeSuperAdminCount(target._id)) === 0) throw ApiError.conflict('At least one active Super Admin must remain');
  } else if (await Order.exists({ userId: target._id })) {
    throw ApiError.conflict('This customer has orders. Deactivate the account instead of deleting it.');
  }
  await tokens.revokeAllForUser(target._id, 'ADMIN_ACTION');
  await target.deleteOne();
  audit(req, { action: 'users.delete', resource: 'users', resourceId: target._id, summary: `Deleted ${target.email}` });
  res.json({ success: true, data: { _id: target._id } });
});

module.exports = { list, getOne, create, update, resetPassword, revokeSessions, remove };
