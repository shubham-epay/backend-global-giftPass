const crypto = require('crypto');
const {
  Cart, Coupon, Order, OrderItem, User, Voucher,
} = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { runInTransaction } = require('../../utils/transaction');
const { priceCart, evaluateCoupon, totals } = require('../../services/pricing.service');
const { cartView, getOrCreateCart } = require('./cart.controller');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateOrderNumber() {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  let tail = '';
  for (let i = 0; i < 6; i += 1) tail += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `GGP-${ymd}-${tail}`;
}

const VOUCHER_PUBLIC = 'code value currency recipientName recipientEmail senderName message expiryDate status issuedAt sentAt redeemedAt productId giftBoxId orderId orderItemId';

// ---------------- Checkout ----------------
const applyCoupon = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  const priced = await priceCart(cart);
  if (priced.subtotal <= 0) throw ApiError.badRequest('Your cart is empty');
  await evaluateCoupon(req.body.code, priced, req.user._id); // throws 422 COUPON_INVALID with the reason
  cart.couponCode = req.body.code;
  await cart.save();
  res.json({ success: true, data: await cartView(cart, req.user._id) });
});

const removeCoupon = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.couponCode = undefined;
  await cart.save();
  res.json({ success: true, data: await cartView(cart, req.user._id) });
});

/**
 * Converts the cart into a PENDING order. Prices are recomputed server side, the coupon is
 * re-validated and its usage is claimed atomically, and the cart is emptied - all in one transaction.
 * The order moves to PAID via the payment provider webhook (or an admin), which is when vouchers are issued.
 */
const checkout = asyncHandler(async (req, res) => {
  const { deliveryMethod, billingAddressId, shippingAddressId, senderName } = req.body;
  const customer = await User.findById(req.user._id).select('name email phone addresses').lean();
  const findAddress = (id) => {
    if (!id) return undefined;
    const a = (customer.addresses || []).find((x) => String(x._id) === String(id));
    if (!a) throw new ApiError(422, 'VALIDATION_ERROR', 'Address not found', [{ path: billingAddressId === id ? 'billingAddressId' : 'shippingAddressId', message: 'Unknown address' }]);
    const { _id, isDefault, ...rest } = a;
    return rest;
  };
  const billingAddress = findAddress(billingAddressId);
  const shippingAddress = findAddress(shippingAddressId);

  const result = await runInTransaction(async (session) => {
    const cart = await Cart.findOne({ userId: req.user._id }).session(session);
    if (!cart || cart.items.length === 0) throw ApiError.badRequest('Your cart is empty');
    const priced = await priceCart(cart);
    const unavailable = priced.lines.filter((l) => !l.available);
    if (unavailable.length) {
      throw new ApiError(409, 'CART_ITEMS_UNAVAILABLE', 'Some items in your cart are no longer available. Remove them to continue.',
        unavailable.map((l) => ({ path: `items.${l._id}`, message: `${l.item?.title || 'Item'} is unavailable` })));
    }

    const couponCode = req.body.couponCode !== undefined ? req.body.couponCode : cart.couponCode;
    let coupon = null;
    let discount = 0;
    if (couponCode) {
      const evaluated = await evaluateCoupon(couponCode, priced, req.user._id);
      coupon = evaluated.coupon;
      discount = evaluated.discount;
      // Atomic claim so concurrent checkouts cannot exceed the usage limit.
      const claimed = await Coupon.findOneAndUpdate(
        { _id: coupon._id, $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
        { $inc: { usedCount: 1 } },
        { session, new: true },
      );
      if (!claimed) throw new ApiError(422, 'COUPON_INVALID', 'This coupon has reached its usage limit', [{ path: 'code', message: 'Usage limit reached' }]);
    }

    const sums = await totals(priced.subtotal, discount);
    const now = new Date();
    // 31^6 codes per day: a collision is negligible, and would surface as a retryable 409.
    const [order] = await Order.create([{
      orderNumber: generateOrderNumber(),
      userId: customer._id,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      itemCount: priced.itemCount,
      currency: 'AED',
      subtotal: sums.subtotal,
      discountTotal: sums.discountTotal,
      taxTotal: sums.taxTotal,
      total: sums.total,
      couponId: coupon?._id,
      couponCode: coupon?.code,
      orderStatus: 'PENDING',
      paymentStatus: 'PENDING',
      statusHistory: [{ to: 'PENDING', source: 'CUSTOMER', at: now, note: 'Order placed' }],
      deliveryMethod,
      billingAddress,
      shippingAddress,
      placedAt: now,
    }], { session });

    const items = await OrderItem.insertMany(priced.lines.map((l) => ({
      orderId: order._id,
      itemType: l.itemType,
      productId: l.itemType === 'PRODUCT' ? l.productId : undefined,
      giftBoxId: l.itemType === 'GIFT_BOX' ? l.giftBoxId : undefined,
      titleSnapshot: l.item.title,
      imageUrlSnapshot: l.item.imageUrl,
      partnerId: l.item.partnerId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
      recipient: {
        name: l.recipient?.name || customer.name,
        email: l.recipient?.email || customer.email,
        phone: l.recipient?.phone || customer.phone,
      },
      senderName: senderName || customer.name,
      message: l.message,
    })), { session });

    cart.items = [];
    cart.couponCode = undefined;
    await cart.save({ session });
    return { order, items };
  });

  res.status(201).json({ success: true, data: { ...result.order.toObject(), items: result.items } });
});

// ---------------- Orders ----------------
const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const filter = { userId: req.user._id, ...(status && { orderStatus: status }) };
  const [orders, total] = await Promise.all([
    Order.find(filter).select('-notes -statusHistory.changedBy -paymentId').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  const items = await OrderItem.find({ orderId: { $in: orders.map((o) => o._id) } })
    .select('orderId titleSnapshot imageUrlSnapshot quantity lineTotal').lean();
  const byOrder = items.reduce((m, i) => m.set(String(i.orderId), [...(m.get(String(i.orderId)) || []), i]), new Map());
  res.json({
    success: true,
    data: orders.map((o) => ({ ...o, items: byOrder.get(String(o._id)) || [] })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id }).select('-notes -statusHistory.changedBy').lean();
  if (!order) throw ApiError.notFound('Order');
  const [items, vouchers] = await Promise.all([
    OrderItem.find({ orderId: order._id }).select('-partnerId').lean(),
    Voucher.find({ orderId: order._id }).select(VOUCHER_PUBLIC).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ success: true, data: { ...order, items, vouchers } });
});

module.exports = { applyCoupon, removeCoupon, checkout, listOrders, getOrder, VOUCHER_PUBLIC };
