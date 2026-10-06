const crypto = require('crypto');
const {
  Cart, Coupon, Order, OrderItem, User, Voucher,
} = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { runInTransaction } = require('../../utils/transaction');
const { priceCart, evaluateCoupon, totals } = require('../../services/pricing.service');
const { resolveCart, cartResponse } = require('./cart.controller');
const { COUNTRIES, flagOf } = require('../../constants/countries');
const { dialCodeOf, UAE_EMIRATES } = require('../../utils/contact');
const payments = require('../../services/payment.service');

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
/** Countries for the checkout form, with dialling codes for the phone field. Static reference data. */
const COUNTRY_OPTIONS = COUNTRIES
  .map((c) => ({ code: c.code, name: c.name, flag: flagOf(c.code), dialCode: dialCodeOf(c.code) }))
  .filter((c) => c.dialCode)
  .sort((a, b) => a.name.localeCompare(b.name));

const checkoutCountries = (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ success: true, data: { countries: COUNTRY_OPTIONS, emirates: UAE_EMIRATES } });
};

const applyCoupon = asyncHandler(async (req, res) => {
  const resolved = await resolveCart(req);
  if (!resolved.cart) throw ApiError.badRequest('Your cart is empty');
  const priced = await priceCart(resolved.cart);
  if (priced.subtotal <= 0) throw ApiError.badRequest('Your cart is empty');
  await evaluateCoupon(req.body.code, priced, req.user?._id); // throws 422 COUPON_INVALID with the reason
  resolved.cart.couponCode = req.body.code;
  await resolved.cart.save();
  res.json(await cartResponse(req, resolved));
});

const removeCoupon = asyncHandler(async (req, res) => {
  const resolved = await resolveCart(req);
  if (resolved.cart) {
    resolved.cart.couponCode = undefined;
    await resolved.cart.save();
  }
  res.json(await cartResponse(req, resolved));
});

const countryName = (code) => COUNTRIES.find((c) => c.code === code)?.name || code;
const toAddress = (a, phone) => ({
  fullName: `${a.firstName} ${a.lastName}`.trim(),
  phone,
  line1: a.address,
  line2: a.apartment || undefined,
  city: a.city,
  state: a.state || undefined,
  country: countryName(a.country),
  postalCode: a.postalCode || undefined,
});

/**
 * Converts the cart (guest or signed-in) into a PENDING order. Prices are recomputed server side, the
 * coupon is re-validated and its usage claimed atomically, and the cart is emptied - all in one transaction.
 * The order moves to PAID via the payment provider webhook (or an admin), which is when vouchers are issued.
 */
const checkout = asyncHandler(async (req, res) => {
  const b = req.body; // validated: email pattern, country, E.164 phone valid for that country
  const name = `${b.firstName} ${b.lastName}`.trim();
  const shippingAddress = toAddress(b, b.phone);
  const billingAddress = b.billingSameAsShipping ? shippingAddress : toAddress(b.billing, b.phone);
  const userId = req.user?._id;
  const payToken = payments.newPayToken(); // lets a guest pay for / check this order later

  const { cart: found } = await resolveCart(req);
  if (!found || found.items.length === 0) throw ApiError.badRequest('Your cart is empty');

  const result = await runInTransaction(async (session) => {
    const cart = await Cart.findById(found._id).session(session);
    if (!cart || cart.items.length === 0) throw ApiError.badRequest('Your cart is empty');
    const priced = await priceCart(cart);
    const unavailable = priced.lines.filter((l) => !l.available);
    if (priced.currency === 'MIXED') {
      throw new ApiError(409, 'CART_MIXED_CURRENCY', 'Your cart has items in different currencies. Check out one currency at a time.');
    }
    if (unavailable.length) {
      throw new ApiError(409, 'CART_ITEMS_UNAVAILABLE', 'Some items in your cart are no longer available. Remove them to continue.',
        unavailable.map((l) => ({ path: `items.${l._id}`, message: `${l.item?.title || 'Item'}: ${l.unavailableReason || 'unavailable'}` })));
    }

    const couponCode = b.couponCode !== undefined ? b.couponCode : cart.couponCode;
    let coupon = null;
    let discount = 0;
    if (couponCode) {
      const evaluated = await evaluateCoupon(couponCode, priced, userId, b.email);
      coupon = evaluated.coupon;
      discount = evaluated.discount;
      // Atomic claim so concurrent checkouts cannot exceed the usage limit.
      const claimed = await Coupon.findOneAndUpdate(
        { _id: coupon._id, $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
        { $inc: { usedCount: 1 } },
        { session, new: true },
      );
      if (!claimed) throw new ApiError(422, 'COUPON_INVALID', 'This coupon has reached its usage limit', [{ path: 'couponCode', message: 'Usage limit reached' }]);
    }

    const sums = await totals(priced.subtotal, discount);
    const now = new Date();
    // 31^6 codes per day: a collision is negligible, and would surface as a retryable 409.
    const [order] = await Order.create([{
      orderNumber: generateOrderNumber(),
      userId,
      isGuest: !userId,
      customer: { name, email: b.email, phone: b.phone },
      itemCount: priced.itemCount,
      currency: priced.currency,
      subtotal: sums.subtotal,
      discountTotal: sums.discountTotal,
      taxTotal: sums.taxTotal,
      total: sums.total,
      couponId: coupon?._id,
      couponCode: coupon?.code,
      orderStatus: 'PENDING',
      paymentStatus: 'PENDING',
      paymentMethod: b.paymentMethod,
      payTokenHash: payToken.hash,
      statusHistory: [{ to: 'PENDING', source: 'CUSTOMER', at: now, note: userId ? 'Order placed' : 'Order placed (guest checkout)' }],
      deliveryMethod: 'EMAIL',
      billingAddress,
      shippingAddress,
      placedAt: now,
    }], { session });

    const items = await OrderItem.insertMany(priced.lines.map((l) => ({
      orderId: order._id,
      itemType: l.itemType,
      productId: l.itemType === 'PRODUCT' ? l.productId : undefined,
      giftBoxId: l.itemType === 'GIFT_BOX' ? l.giftBoxId : undefined,
      // e.g. "PSN UAE · 20 USD" so the order and voucher show which value was bought
      titleSnapshot: l.amount != null ? `${l.item.title} · ${l.amount} ${l.currency}`.slice(0, 200) : l.item.title,
      imageUrlSnapshot: l.item.imageUrl,
      partnerId: l.item.partnerId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
      recipient: {
        name: l.recipient?.name || name,
        email: l.recipient?.email || b.email,
        phone: l.recipient?.phone || b.phone,
      },
      senderName: b.senderName || name,
      message: l.message,
    })), { session });

    if (cart.userId) {
      cart.items = [];
      cart.couponCode = undefined;
      await cart.save({ session });
    } else {
      await cart.deleteOne({ session }); // the guest's token is spent
    }
    return { order, items };
  });

  // "Save this information for next time" for a signed-in customer: keep the address and phone on the account.
  if (userId && b.saveInfo) {
    const user = await User.findById(userId).select('phone addresses');
    const same = user.addresses.find((a) => a.line1 === shippingAddress.line1 && a.city === shippingAddress.city && a.country === shippingAddress.country);
    if (!same && user.addresses.length < 20) {
      user.addresses.forEach((a) => { a.isDefault = false; });
      user.addresses.push({ ...shippingAddress, label: 'Checkout', isDefault: true });
    }
    if (!user.phone) user.phone = b.phone;
    await user.save().catch(() => {}); // saving preferences must never fail a placed order
  }

  // Start the online payment. If the provider is down the order is still placed and the
  // storefront can retry from the pay page with the pay token.
  let payment = null;
  let paymentError = null;
  if (payments.SYNRAPAY_METHODS.includes(b.paymentMethod)) {
    try {
      payment = await payments.startPayment(result.order, b.paymentMethod, {
        linkType: b.paymentLinkType, expiresInHours: b.paymentLinkExpiresInHours, captureMode: b.directCaptureMode, origin: req.get('origin'),
      });
    } catch (err) {
      paymentError = { code: err.code || 'PAYMENT_START_FAILED', message: err.isOperational ? err.message : 'The payment could not be started' };
      if (!err.isOperational) console.error(`[checkout] ${result.order.orderNumber} payment start failed`, err);
    }
  }

  const o = result.order.toObject();
  res.status(201).json({
    success: true,
    data: {
      _id: o._id, orderNumber: o.orderNumber, isGuest: o.isGuest, customer: o.customer, currency: o.currency,
      subtotal: o.subtotal, discountTotal: o.discountTotal, taxTotal: o.taxTotal, total: o.total, couponCode: o.couponCode,
      orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, paymentMethod: o.paymentMethod,
      shippingAddress: o.shippingAddress, placedAt: o.placedAt,
      items: result.items.map((i) => ({
        _id: i._id, titleSnapshot: i.titleSnapshot, imageUrlSnapshot: i.imageUrlSnapshot, quantity: i.quantity,
        unitPrice: i.unitPrice, lineTotal: i.lineTotal, recipient: i.recipient,
      })),
      payToken: payToken.token,
      payment,
      paymentError,
    },
  });
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

module.exports = { checkoutCountries, applyCoupon, removeCoupon, checkout, listOrders, getOrder, VOUCHER_PUBLIC };
