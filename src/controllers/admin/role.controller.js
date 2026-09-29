const { Role, User } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex } = require('../../utils/helpers');
const { audit } = require('../../services/audit.service');
const { PERMISSION_GROUPS, SUPER } = require('../../constants/permissions');

/** Actors may only grant permissions they themselves hold (prevents privilege escalation). */
function assertCanGrant(actorPerms, permissions) {
  if (actorPerms.has(SUPER)) return;
  if (permissions.includes(SUPER)) throw ApiError.forbidden('Only a Super Admin can grant full access');
  const notHeld = permissions.filter((p) => !actorPerms.has(p));
  if (notHeld.length) throw ApiError.forbidden(`You cannot grant permissions you do not hold: ${notHeld.join(', ')}`);
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, q, ids } = req.query;
  const filter = q ? { name: new RegExp(escapeRegex(q), 'i') } : {};
  if (ids) filter._id = { $in: ids.split(',').filter((id) => /^[a-f\d]{24}$/i.test(id)) };
  const [roles, total] = await Promise.all([
    Role.find(filter).sort({ isSystem: -1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Role.countDocuments(filter),
  ]);
  const counts = await User.aggregate([
    { $match: { type: 'ADMIN', roleId: { $in: roles.map((r) => r._id) } } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  const byRole = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
  res.json({
    success: true,
    data: roles.map((r) => ({ ...r, userCount: byRole[String(r._id)] || 0 })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

const getOne = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound('Role');
  res.json({ success: true, data: role });
});

const create = asyncHandler(async (req, res) => {
  assertCanGrant(req.user.permissions, req.body.permissions || []);
  const role = await Role.create({ ...req.body, isSystem: false });
  audit(req, { action: 'roles.create', resource: 'roles', resourceId: role._id, summary: `Created role "${role.name}"`, changes: { permissions: role.permissions } });
  res.status(201).json({ success: true, data: role });
});

const update = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound('Role');
  if (role.isSystem) throw ApiError.forbidden('System roles cannot be modified');
  if (req.body.permissions) {
    assertCanGrant(req.user.permissions, req.body.permissions);
    // Also stop an actor from editing a role that currently holds more than they do.
    assertCanGrant(req.user.permissions, role.permissions);
  }
  const before = { name: role.name, permissions: [...role.permissions] };
  role.set(req.body);
  await role.save();
  // No token invalidation needed: permissions are re-read from the DB on every request.
  audit(req, { action: 'roles.update', resource: 'roles', resourceId: role._id, summary: `Updated role "${role.name}"`, changes: { before, after: { name: role.name, permissions: role.permissions } } });
  res.json({ success: true, data: role });
});

const remove = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound('Role');
  if (role.isSystem) throw ApiError.forbidden('System roles cannot be deleted');
  const inUse = await User.countDocuments({ roleId: role._id });
  if (inUse) throw ApiError.conflict(`This role is assigned to ${inUse} user(s). Reassign them first.`);
  await role.deleteOne();
  audit(req, { action: 'roles.delete', resource: 'roles', resourceId: role._id, summary: `Deleted role "${role.name}"` });
  res.json({ success: true, data: { _id: role._id } });
});

const permissions = (_req, res) => res.json({ success: true, data: PERMISSION_GROUPS });

module.exports = { list, getOne, create, update, remove, permissions, assertCanGrant };
