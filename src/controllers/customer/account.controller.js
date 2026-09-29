const { User, Order, Voucher } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { serializeCustomer } = require('./auth.controller');
const { VOUCHER_PUBLIC } = require('./order.controller');

const MAX_ADDRESSES = 20;

// ---------------- Profile ----------------
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  res.json({ success: true, data: { ...serializeCustomer(user), addresses: user.addresses || [] } });
});

const updateProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  for (const key of ['name', 'phone', 'avatarUrl']) {
    if (req.body[key] !== undefined) user[key] = req.body[key] || undefined;
  }
  await user.save();
  res.json({ success: true, data: { ...serializeCustomer(user), addresses: user.addresses || [] } });
});

// ---------------- Addresses ----------------
/** Exactly one default address whenever there is at least one address. */
function normaliseDefault(user, preferredId) {
  const list = user.addresses;
  if (!list.length) return;
  const target = preferredId ? list.id(preferredId) : list.find((a) => a.isDefault) || list[0];
  list.forEach((a) => { a.isDefault = String(a._id) === String(target._id); });
}

const listAddresses = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('addresses').lean();
  res.json({ success: true, data: user.addresses || [] });
});

const addAddress = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('addresses');
  if (user.addresses.length >= MAX_ADDRESSES) throw ApiError.conflict(`You can save up to ${MAX_ADDRESSES} addresses`);
  user.addresses.push(req.body);
  const added = user.addresses[user.addresses.length - 1];
  normaliseDefault(user, req.body.isDefault || user.addresses.length === 1 ? added._id : undefined);
  await user.save();
  res.status(201).json({ success: true, data: user.addresses });
});

const updateAddress = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('addresses');
  const address = user.addresses.id(req.params.id);
  if (!address) throw ApiError.notFound('Address');
  address.set(req.body);
  normaliseDefault(user, req.body.isDefault ? address._id : undefined);
  await user.save();
  res.json({ success: true, data: user.addresses });
});

const removeAddress = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('addresses');
  const address = user.addresses.id(req.params.id);
  if (!address) throw ApiError.notFound('Address');
  address.deleteOne();
  normaliseDefault(user);
  await user.save();
  res.json({ success: true, data: user.addresses });
});

// ---------------- My vouchers ----------------
/** Vouchers the customer bought (for anyone) and vouchers gifted to their email address. */
const myVouchers = asyncHandler(async (req, res) => {
  const { page, limit, status, type } = req.query;
  const orderIds = (await Order.find({ userId: req.user._id }).select('_id').lean()).map((o) => o._id);
  const or = [];
  if (type !== 'received') or.push({ orderId: { $in: orderIds } });
  if (type !== 'purchased') or.push({ recipientEmail: req.user.email });
  const filter = { $or: or, ...(status && { status }) };

  const [items, total] = await Promise.all([
    Voucher.find(filter).select(VOUCHER_PUBLIC).sort({ issuedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('productId', 'title slug imageUrls city duration')
      .populate('giftBoxId', 'name coverImageUrl')
      .lean(),
    Voucher.countDocuments(filter),
  ]);
  const mine = new Set(orderIds.map(String));
  res.json({
    success: true,
    data: items.map((v) => ({
      ...v,
      purchased: mine.has(String(v.orderId)),
      received: v.recipientEmail === req.user.email,
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

module.exports = {
  getProfile, updateProfile, listAddresses, addAddress, updateAddress, removeAddress, myVouchers,
};
