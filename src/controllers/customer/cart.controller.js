const { Cart, Wishlist, Product, GiftBox } = require('../../models');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const {
  PRODUCT_CARD_FIELDS, priceCart, evaluateCoupon, totals,
} = require('../../services/pricing.service');

const MAX_CART_LINES = 50;

const getOrCreateCart = (userId) => Cart.findOneAndUpdate(
  { userId },
  { $setOnInsert: { userId, items: [] } },
  { upsert: true, new: true, setDefaultsOnInsert: true },
);

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
    ...(await totals(priced.subtotal, coupon?.discount || 0)),
  };
}

// ---------------- Cart ----------------
const getCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  res.json({ success: true, data: await cartView(cart, req.user._id) });
});

const addItem = asyncHandler(async (req, res) => {
  const { itemType, productId, giftBoxId, quantity, recipient, message } = req.body;
  const Model = itemType === 'PRODUCT' ? Product : GiftBox;
  const refId = itemType === 'PRODUCT' ? productId : giftBoxId;
  const doc = await Model.findOne({ _id: refId, status: 'ACTIVE' }).select('price salePrice').lean();
  if (!doc) throw ApiError.notFound(itemType === 'PRODUCT' ? 'Product' : 'Gift box');

  const cart = await getOrCreateCart(req.user._id);
  const refKey = itemType === 'PRODUCT' ? 'productId' : 'giftBoxId';
  const personalised = Boolean(recipient?.email || recipient?.name || message);
  // Plain (non-personalised) lines for the same item are merged; personalised gifts stay separate lines.
  const existing = !personalised && cart.items.find((i) => i.itemType === itemType && String(i[refKey]) === String(refId)
    && !i.message && !i.recipient?.email && !i.recipient?.name);

  if (existing) {
    existing.quantity = Math.min(existing.quantity + quantity, 100);
  } else {
    if (cart.items.length >= MAX_CART_LINES) throw ApiError.conflict(`Your cart can hold up to ${MAX_CART_LINES} items`);
    cart.items.push({
      itemType, [refKey]: refId, quantity, recipient: recipient || undefined, message: message || undefined,
      unitPriceSnapshot: doc.salePrice ?? doc.price,
    });
  }
  await cart.save();
  res.status(201).json({ success: true, data: await cartView(cart, req.user._id) });
});

const updateItem = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  const item = cart.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound('Cart item');
  const { quantity, recipient, message } = req.body;
  if (quantity !== undefined) item.quantity = quantity;
  if (recipient !== undefined) item.recipient = recipient || undefined;
  if (message !== undefined) item.message = message || undefined;
  await cart.save();
  res.json({ success: true, data: await cartView(cart, req.user._id) });
});

const removeItem = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  const item = cart.items.id(req.params.itemId);
  if (!item) throw ApiError.notFound('Cart item');
  item.deleteOne();
  await cart.save();
  res.json({ success: true, data: await cartView(cart, req.user._id) });
});

const clearCart = asyncHandler(async (req, res) => {
  const cart = await getOrCreateCart(req.user._id);
  cart.items = [];
  cart.couponCode = undefined;
  await cart.save();
  res.json({ success: true, data: await cartView(cart, req.user._id) });
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
  getOrCreateCart, cartView, getCart, addItem, updateItem, removeItem, clearCart,
  getWishlist, addToWishlist, removeFromWishlist,
};
