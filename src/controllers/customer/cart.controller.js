const crypto = require('crypto');
const { Cart, Wishlist, Product, GiftBox } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const {
  PRODUCT_CARD_FIELDS, priceCart, evaluateCoupon, totals, needsAmount, amountProblem,
} = require('../../services/pricing.service');

const MAX_CART_LINES = 50;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url'); // 43 url-safe chars

const sameLine = (a, b) => a.itemType === b.itemType && String(a.productId || a.giftBoxId) === String(b.productId || b.giftBoxId)
  && (a.amount ?? null) === (b.amount ?? null) && !a.message && !b.message
  && !a.recipient?.email && !b.recipient?.email && !a.recipient?.name && !b.recipient?.name;

/** Moves a guest cart's lines into the signed-in customer's cart (plain duplicates are merged) and deletes it. */
async function mergeGuestCart(userCart, token) {
  const guest = await Cart.findOne({ guestTokenHash: hashToken(token) });
  if (!guest) return;
  for (const line of guest.items) {
    const plain = line.toObject();
    delete plain._id;
    const existing = userCart.items.find((i) => sameLine(i, plain));
    if (existing) existing.quantity = Math.min(existing.quantity + plain.quantity, 100);
    else if (userCart.items.length < MAX_CART_LINES) userCart.items.push(plain);
  }
  if (!userCart.couponCode && guest.couponCode) userCart.couponCode = guest.couponCode;
  await userCart.save();
  await guest.deleteOne();
}

/**
 * The request's cart: the customer's (merging any guest cart they built before signing in), or the guest
 * cart for X-Cart-Token. With `create`, a guest without a cart gets one and `issuedToken` is returned
 * for the browser to keep. Without `create`, a guest with no cart gets `cart: null`.
 */
async function resolveCart(req, { create = false } = {}) {
  if (req.user) {
    const cart = await Cart.findOneAndUpdate(
      { userId: req.user._id },
      { $setOnInsert: { userId: req.user._id, items: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (req.cartToken) await mergeGuestCart(cart, req.cartToken);
    return { cart, merged: Boolean(req.cartToken) };
  }
  if (req.cartToken) {
    const cart = await Cart.findOne({ guestTokenHash: hashToken(req.cartToken) });
    if (cart) return { cart };
  }
  if (!create) return { cart: null };
  const token = newToken();
  const cart = new Cart({ guestTokenHash: hashToken(token), items: [] });
  return { cart, issuedToken: token };
}

const EMPTY_CART = { _id: null, items: [], couponCode: undefined };

/** JSON body for a cart response, carrying a newly issued guest token when there is one. */
async function cartResponse(req, { cart, issuedToken, merged }) {
  const view = await cartView(cart || EMPTY_CART, req.user?._id);
  return { success: true, data: { ...view, ...(issuedToken && { cartToken: issuedToken }), ...(merged && { guestCartMerged: true }) } };
}

/** Priced view of the cart, including the coupon preview (never throws for a coupon that stopped applying). */
async function cartView(cart, userId) {
  const priced = await priceCart(cart);
  let coupon = null;
  let couponError = null;
  if (cart.couponCode && priced.subtotal > 0) {
    try {
      coupon = (await evaluateCoupon(cart.couponCode, priced, userId)).summary;
    } catch (err) {
      if (err.code !== 'COUPON_INVALID') throw err;
      couponError = err.message;
    }
  }
  return {
    _id: cart._id,
    items: priced.lines,
    itemCount: priced.itemCount,
    hasUnavailableItems: priced.lines.some((l) => !l.available),
    couponCode: cart.couponCode || null,
    coupon,
    couponError,
    currency: priced.currency,
    ...(await totals(priced.subtotal, coupon?.discount || 0)),
  };
}

// ---------------- Cart ----------------
const getCart = asyncHandler(async (req, res) => {
  res.json(await cartResponse(req, await resolveCart(req)));
});

const addItem = asyncHandler(async (req, res) => {
  const { itemType, productId, giftBoxId, quantity, recipient, message } = req.body;
  const Model = itemType === 'PRODUCT' ? Product : GiftBox;
  const refId = itemType === 'PRODUCT' ? productId : giftBoxId;
  const doc = await Model.findOne({ _id: refId, status: 'ACTIVE' }).select('price salePrice currency amountMin amountMax denominations.value denominations.price').lean();
  if (!doc) throw ApiError.notFound(itemType === 'PRODUCT' ? 'Product' : 'Gift box');
  const amount = needsAmount(doc) ? req.body.amount : undefined;
  const problem = amountProblem(doc, amount);
  if (problem) throw new ApiError(422, 'VALIDATION_ERROR', problem, [{ path: 'amount', message: problem }]);

  const resolved = await resolveCart(req, { create: true });
  const { cart } = resolved;
  // No currency conversion: a cart holds items in one currency only.
  const current = (await priceCart(cart)).currency;
  const incoming = doc.currency || 'AED';
  if (cart.items.length && current !== 'MIXED' && current !== incoming) {
    throw ApiError.conflict(`Your cart has items priced in ${current}. Check them out or remove them before adding items in ${incoming}.`);
  }
  const refKey = itemType === 'PRODUCT' ? 'productId' : 'giftBoxId';
  const personalised = Boolean(recipient?.email || recipient?.name || message);
  // Plain (non-personalised) lines for the same item are merged; personalised gifts stay separate lines.
  const existing = !personalised && cart.items.find((i) => i.itemType === itemType && String(i[refKey]) === String(refId)
    && !i.message && !i.recipient?.email && !i.recipient?.name && (i.amount ?? null) === (amount ?? null));

  if (existing) {
    existing.quantity = Math.min(existing.quantity + quantity, 100);
  } else {
    if (cart.items.length >= MAX_CART_LINES) throw ApiError.conflict(`Your cart can hold up to ${MAX_CART_LINES} items`);
    cart.items.push({
      itemType, [refKey]: refId, quantity, recipient: recipient || undefined, message: message || undefined,
      unitPriceSnapshot: doc.denominations?.find((d) => d.value === amount)?.price ?? amount ?? doc.salePrice ?? doc.price,
      amount,
    });
  }
  await cart.save();
  res.status(201).json(await cartResponse(req, resolved));
});

const updateItem = asyncHandler(async (req, res) => {
  const resolved = await resolveCart(req);
  const item = resolved.cart?.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound('Cart item');
  const { quantity, recipient, message } = req.body;
  if (quantity !== undefined) item.quantity = quantity;
  if (recipient !== undefined) item.recipient = recipient || undefined;
  if (message !== undefined) item.message = message || undefined;
  await resolved.cart.save();
  res.json(await cartResponse(req, resolved));
});

const removeItem = asyncHandler(async (req, res) => {
  const resolved = await resolveCart(req);
  const item = resolved.cart?.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound('Cart item');
  item.deleteOne();
  await resolved.cart.save();
  res.json(await cartResponse(req, resolved));
});

const clearCart = asyncHandler(async (req, res) => {
  const resolved = await resolveCart(req);
  if (resolved.cart) {
    resolved.cart.items = [];
    resolved.cart.couponCode = undefined;
    await resolved.cart.save();
  }
  res.json(await cartResponse(req, resolved));
});

// ---------------- Wishlist ----------------
async function wishlistView(userId) {
  const wl = await Wishlist.findOne({ userId }).lean();
  const ids = (wl?.items || []).map((i) => i.productId);
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } }).select(`${PRODUCT_CARD_FIELDS} status`).populate('partnerId', 'name city').lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return (wl?.items || [])
    .map((i) => ({ productId: i.productId, addedAt: i.addedAt, product: byId.get(String(i.productId)) || null }))
    .map((i) => ({ ...i, available: i.product?.status === 'ACTIVE' }))
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
}

const getWishlist = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await wishlistView(req.user._id) });
});

const addToWishlist = asyncHandler(async (req, res) => {
  const { productId } = req.body;
  if (!(await Product.exists({ _id: productId, status: 'ACTIVE' }))) throw ApiError.notFound('Product');
  const r = await Wishlist.updateOne(
    { userId: req.user._id, 'items.productId': { $ne: productId } },
    { $push: { items: { productId, addedAt: new Date() } } },
  );
  // No match means either no wishlist yet (create it) or the product is already saved (no-op).
  if (r.matchedCount === 0 && !(await Wishlist.exists({ userId: req.user._id }))) {
    await Wishlist.create({ userId: req.user._id, items: [{ productId }] });
  }
  res.status(201).json({ success: true, data: await wishlistView(req.user._id) });
});

const removeFromWishlist = asyncHandler(async (req, res) => {
  await Wishlist.updateOne({ userId: req.user._id }, { $pull: { items: { productId: req.params.productId } } });
  res.json({ success: true, data: await wishlistView(req.user._id) });
});

module.exports = {
  resolveCart, cartResponse, hashToken, cartView, getCart, addItem, updateItem, removeItem, clearCart,
  getWishlist, addToWishlist, removeFromWishlist,
};
