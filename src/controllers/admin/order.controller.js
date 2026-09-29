const mongoose = require('mongoose');
const { Order, OrderItem, Payment, Voucher } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex, isObjectId } = require('../../utils/helpers');
const { runInTransaction } = require('../../utils/transaction');
const { audit } = require('../../services/audit.service');
const { ORDER_TRANSITIONS, ORDER_STATUS, PAYMENT_STATUS } = require('../../constants/enums');

const parseDate = (v) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`Invalid date "${v}"`);
  return d;
};

const list = asyncHandler(async (req, res) => {
  const { page, limit, q, orderStatus, paymentStatus, userId, from, to, sort, ids } = req.query;
  const filter = {};
  if (ids) filter._id = { $in: ids.split(',').filter(isObjectId) };
  if (orderStatus && ORDER_STATUS.includes(orderStatus)) filter.orderStatus = orderStatus;
  if (paymentStatus && PAYMENT_STATUS.includes(paymentStatus)) filter.paymentStatus = paymentStatus;
  if (userId && isObjectId(userId)) filter.userId = new mongoose.Types.ObjectId(userId);
  const fromD = parseDate(from); const toD = parseDate(to);
  if (fromD || toD) filter.createdAt = { ...(fromD && { $gte: fromD }), ...(toD && { $lte: toD }) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ orderNumber: rx }, { 'customer.email': rx }, { 'customer.name': rx }, { couponCode: rx }];
  }
  const sortable = ['createdAt', 'total', 'orderNumber'];
  const field = (sort || '-createdAt').replace(/^-/, '');
  const sortObj = sortable.includes(field) ? { [field]: (sort || '-createdAt').startsWith('-') ? -1 : 1 } : { createdAt: -1 };

  const [items, total] = await Promise.all([
    Order.find(filter).select('-statusHistory -billingAddress -shippingAddress').sort(sortObj)
      .skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
});

const getOne = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('statusHistory.changedBy', 'name email')
    .populate('userId', 'name email phone')
    .lean();
  if (!order) throw ApiError.notFound('Order');
  const [items, payments, vouchers] = await Promise.all([
    OrderItem.find({ orderId: order._id }).lean(),
    Payment.find({ orderId: order._id }).sort({ createdAt: -1 }).lean(),
    Voucher.find({ orderId: order._id }).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({
    success: true,
    data: { ...order, items, payments, vouchers, allowedTransitions: ORDER_TRANSITIONS[order.orderStatus] || [] },
  });
});

const updateStatus = asyncHandler(async (req, res) => {
  const { orderStatus: to, trackingNumber, notes } = req.body;

  const { order, from, cancelledVouchers } = await runInTransaction(async (session) => {
    const doc = await Order.findById(req.params.id).session(session);
    if (!doc) throw ApiError.notFound('Order');
    const current = doc.orderStatus;

    if (current !== to && !(ORDER_TRANSITIONS[current] || []).includes(to)) {
      throw new ApiError(422, 'INVALID_TRANSITION', `Order cannot move from ${current} to ${to}`, [{ path: 'orderStatus', message: `Allowed: ${(ORDER_TRANSITIONS[current] || []).join(', ') || 'none (final status)'}` }]);
    }
    if (to === 'SENT' && doc.deliveryMethod === 'PHYSICAL' && !trackingNumber && !doc.trackingNumber) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'A tracking number is required for physical deliveries', [{ path: 'trackingNumber', message: 'Required' }]);
    }

    if (trackingNumber !== undefined) doc.trackingNumber = trackingNumber || undefined;
    if (notes !== undefined) doc.notes = notes || undefined;

    let voided = 0;
    if (current !== to) {
      const now = new Date();
      doc.orderStatus = to;
      doc.statusHistory.push({ from: current, to, note: notes || undefined, changedBy: req.user._id, source: 'ADMIN', at: now });
      if (to === 'PAID') { doc.paymentStatus = 'PAID'; doc.paidAt = doc.paidAt || now; }
      if (to === 'CANCELLED') doc.cancelledAt = now;
      if (to === 'REFUNDED') { doc.paymentStatus = 'REFUNDED'; doc.refundedAt = now; }

      if (to === 'CANCELLED' || to === 'REFUNDED') {
        const r = await Voucher.updateMany(
          { orderId: doc._id, status: 'ACTIVE' },
          { status: 'CANCELLED', cancelledAt: now, statusReason: `Order ${to.toLowerCase()}`, updatedBy: req.user._id },
          { session },
        );
        voided = r.modifiedCount;
      }
    }
    await doc.save({ session });
    return { order: doc, from: current, cancelledVouchers: voided };
  });

  audit(req, {
    action: 'orders.updateStatus', resource: 'orders', resourceId: order._id,
    summary: `Order ${order.orderNumber}: ${from} → ${to}${cancelledVouchers ? ` (${cancelledVouchers} voucher(s) cancelled)` : ''}`,
    changes: { orderStatus: { from, to }, trackingNumber, notes },
  });
  res.json({ success: true, data: { order, cancelledVouchers } });
});

module.exports = { list, getOne, updateStatus };
