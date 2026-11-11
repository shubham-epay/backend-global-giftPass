const mongoose = require('mongoose');
const { Voucher, Order, OrderItem, GiftBox, Product, Partner } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { escapeRegex, isObjectId } = require('../../utils/helpers');
const { audit } = require('../../services/audit.service');
const { createVoucherWithUniqueCode } = require('../../services/voucher.service');
const { VOUCHER_TRANSITIONS, VOUCHER_STATUS, VOUCHER_ISSUABLE_ORDER_STATUSES } = require('../../constants/enums');

const populate = [
  { path: 'orderId', select: 'orderNumber orderStatus customer' },
  { path: 'productId', select: 'title slug' },
  { path: 'giftBoxId', select: 'name' },
  { path: 'redeemedAtPartnerId', select: 'name' },
  { path: 'createdBy', select: 'name email' },
];

const list = asyncHandler(async (req, res) => {
  const { page, limit, q, status, orderId, expiringInDays } = req.query;
  const filter = {};
  if (status && VOUCHER_STATUS.includes(status)) filter.status = status;
  if (orderId && isObjectId(orderId)) filter.orderId = new mongoose.Types.ObjectId(orderId);
  if (expiringInDays && /^\d{1,3}$/.test(expiringInDays)) {
    filter.status = 'ACTIVE';
    filter.expiryDate = { $gte: new Date(), $lte: new Date(Date.now() + Number(expiringInDays) * 864e5) };
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ code: rx }, { recipientEmail: rx }, { recipientName: rx }, { senderName: rx }];
  }
  const [items, total] = await Promise.all([
    Voucher.find(filter).populate(populate.slice(0, 3)).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Voucher.countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
});

const getOne = asyncHandler(async (req, res) => {
  const voucher = await Voucher.findById(req.params.id).populate(populate).lean();
  if (!voucher) throw ApiError.notFound('Voucher');
  res.json({ success: true, data: { ...voucher, allowedTransitions: VOUCHER_TRANSITIONS[voucher.status] || [] } });
});

const create = asyncHandler(async (req, res) => {
  const data = { ...req.body };
  const order = await Order.findById(data.orderId).lean();
  if (!order) throw new ApiError(422, 'INVALID_REFERENCE', 'Order not found', [{ path: 'orderId', message: 'Unknown order' }]);
  if (!VOUCHER_ISSUABLE_ORDER_STATUSES.includes(order.orderStatus)) {
    throw new ApiError(422, 'ORDER_NOT_PAID', `Vouchers can only be issued for paid orders (order is ${order.orderStatus})`, [{ path: 'orderId', message: 'Order is not paid' }]);
  }
  if (data.expiryDate <= new Date()) throw new ApiError(422, 'VALIDATION_ERROR', 'Expiry date must be in the future', [{ path: 'expiryDate', message: 'Must be in the future' }]);

  if (data.orderItemId) {
    const item = await OrderItem.findOne({ _id: data.orderItemId, orderId: order._id }).lean();
    if (!item) throw new ApiError(422, 'INVALID_REFERENCE', 'Order item does not belong to this order', [{ path: 'orderItemId', message: 'Unknown order item' }]);
    data.productId = data.productId || item.productId;
    data.giftBoxId = data.giftBoxId || item.giftBoxId;
    if (data.value == null) data.value = item.unitPrice;
  }
  if (data.giftBoxId) {
    const box = await GiftBox.findById(data.giftBoxId).select('price salePrice').lean();
    if (!box) throw new ApiError(422, 'INVALID_REFERENCE', 'Gift box not found', [{ path: 'giftBoxId', message: 'Unknown gift box' }]);
    if (data.value == null) data.value = box.salePrice ?? box.price;
  }
  if (data.productId && !(await Product.exists({ _id: data.productId }))) {
    throw new ApiError(422, 'INVALID_REFERENCE', 'Product not found', [{ path: 'productId', message: 'Unknown product' }]);
  }

  const voucher = await createVoucherWithUniqueCode({ ...data, currency: order.currency, status: 'ACTIVE', createdBy: req.user._id });
  audit(req, { action: 'vouchers.create', resource: 'vouchers', resourceId: voucher._id, summary: `Issued voucher ${voucher.code} for order ${order.orderNumber}` });
  res.status(201).json({ success: true, data: voucher });
});

const update = asyncHandler(async (req, res) => {
  const voucher = await Voucher.findById(req.params.id);
  if (!voucher) throw ApiError.notFound('Voucher');
  if (voucher.status !== 'ACTIVE') throw ApiError.conflict(`Only active vouchers can be edited (this one is ${voucher.status})`);
  if (req.body.expiryDate && req.body.expiryDate <= new Date()) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Expiry date must be in the future', [{ path: 'expiryDate', message: 'Must be in the future' }]);
  }
  const before = voucher.toObject();
  voucher.set({ ...req.body, updatedBy: req.user._id });
  await voucher.save();
  const changes = Object.fromEntries(Object.keys(req.body).map((k) => [k, { from: before[k], to: voucher.get(k) }]));
  audit(req, { action: 'vouchers.update', resource: 'vouchers', resourceId: voucher._id, summary: `Edited voucher ${voucher.code}`, changes });
  res.json({ success: true, data: voucher });
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status: to, reason, expiryDate, redeemedAtPartnerId, exchangedToVoucherId } = req.body;
  const voucher = await Voucher.findById(req.params.id);
  if (!voucher) throw ApiError.notFound('Voucher');
  const from = voucher.status;
  if (!(VOUCHER_TRANSITIONS[from] || []).includes(to)) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Voucher cannot move from ${from} to ${to}`);
  }
  const now = new Date();
  if (to === 'CANCELLED') {
    if (!reason) throw new ApiError(422, 'VALIDATION_ERROR', 'A reason is required to cancel a voucher', [{ path: 'reason', message: 'Required' }]);
    voucher.cancelledAt = now;
  }
  if (to === 'ACTIVE') {
    if (!expiryDate || expiryDate <= now) throw new ApiError(422, 'VALIDATION_ERROR', 'Set a new future expiry date to reinstate this voucher', [{ path: 'expiryDate', message: 'Must be in the future' }]);
    voucher.expiryDate = expiryDate;
  }
  if (to === 'REDEEMED') {
    if (redeemedAtPartnerId && !(await Partner.exists({ _id: redeemedAtPartnerId }))) throw ApiError.badRequest('Unknown partner');
    voucher.redeemedAt = now;
    voucher.redeemedAtPartnerId = redeemedAtPartnerId || undefined;
  }
  if (to === 'EXCHANGED' && exchangedToVoucherId) {
    if (!(await Voucher.exists({ _id: exchangedToVoucherId }))) throw ApiError.badRequest('Unknown replacement voucher');
    voucher.exchangedToVoucherId = exchangedToVoucherId;
  }
  voucher.status = to;
  voucher.statusReason = reason || voucher.statusReason;
  voucher.updatedBy = req.user._id;
  await voucher.save();
  audit(req, { action: 'vouchers.updateStatus', resource: 'vouchers', resourceId: voucher._id, summary: `Voucher ${voucher.code}: ${from} → ${to}`, changes: { status: { from, to }, reason } });
  res.json({ success: true, data: voucher });
});

module.exports = { list, getOne, create, update, updateStatus };
