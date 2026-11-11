const mongoose = require('mongoose');
const { AuditLog } = require('../../models');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex, isObjectId } = require('../../utils/helpers');
const E = require('../../constants/enums');
const { PERMISSION_GROUPS } = require('../../constants/permissions');

const auditLogs = asyncHandler(async (req, res) => {
  const { page, limit, q, actorId, resource, action, resourceId } = req.query;
  const filter = {};
  if (actorId && isObjectId(actorId)) filter.actorId = new mongoose.Types.ObjectId(actorId);
  if (resource) filter.resource = String(resource);
  if (resourceId) filter.resourceId = String(resourceId);
  if (action) filter.action = new RegExp(`^${escapeRegex(action)}`);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ summary: rx }, { actorEmail: rx }, { action: rx }];
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
});

const meta = (_req, res) => res.json({
  success: true,
  data: {
    permissions: PERMISSION_GROUPS,
    enums: {
      publishStatus: E.PUBLISH_STATUS, productStatus: E.PRODUCT_STATUS, userStatus: E.USER_STATUS,
      discountTypes: E.DISCOUNT_TYPES, orderStatus: E.ORDER_STATUS, orderTransitions: E.ORDER_TRANSITIONS,
      paymentStatus: E.PAYMENT_STATUS, voucherStatus: E.VOUCHER_STATUS, voucherTransitions: E.VOUCHER_TRANSITIONS,
      blogStatus: E.BLOG_STATUS,
    },
  },
});

module.exports = { auditLogs, meta };
