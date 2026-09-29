const { Product, GiftBox, Coupon, Order, Setting } = require('../models');
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/helpers');

const PRODUCT_CARD_FIELDS = 'title slug imageUrls price salePrice currency city country duration validityDays categoryId partnerId featured bestSeller flashSale ratingAvg ratingCount shortDescription';
const GIFT_BOX_CARD_FIELDS = 'name price salePrice currency coverImageUrl validityDays description';

const unitPriceOf = (doc) => (doc.salePrice != null ? doc.salePrice : doc.price);

/**
 * Re-prices a cart against the live catalogue. Prices are never trusted from the client or the
 * cart snapshot; unavailable items (deleted / not ACTIVE) are flagged so the UI can remove them.
 */
async function priceCart(cart) {
  const items = cart?.items || [];
  const productIds = items.filter((i) => i.itemType === 'PRODUCT').map((i) => i.productId);
  const boxIds = items.filter((i) => i.itemType === 'GIFT_BOX').map((i) => i.giftBoxId);
  const [products, boxes] = await Promise.all([
    productIds.length ? Product.find({ _id: { $in: productIds } }).select(`${PRODUCT_CARD_FIELDS} status`).populate('partnerId', 'name').lean() : [],
    boxIds.length ? GiftBox.find({ _id: { $in: boxIds } }).select(`${GIFT_BOX_CARD_FIELDS} status`).lean() : [],
  ]);
  const byId = new Map([...products, ...boxes].map((d) => [String(d._id), d]));

  const lines = items.map((item) => {
    const ref = item.itemType === 'PRODUCT' ? item.productId : item.giftBoxId;
    const doc = byId.get(String(ref));
    const available = Boolean(doc && doc.status === 'ACTIVE');
    const unitPrice = available ? round2(unitPriceOf(doc)) : 0;
    return {
      _id: item._id,
      itemType: item.itemType,
      productId: item.productId,
      giftBoxId: item.giftBoxId,
      quantity: item.quantity,
      recipient: item.recipient,
      message: item.message,
      available,
      unitPrice,
      lineTotal: round2(unitPrice * item.quantity),
      item: doc ? {
        _id: doc._id,
        title: doc.title || doc.name,
        slug: doc.slug,
        imageUrl: doc.imageUrls?.[0] || doc.coverImageUrl,
        price: doc.price,
        salePrice: doc.salePrice,
        currency: doc.currency || 'AED',
        city: doc.city,
        categoryId: doc.categoryId,
        partner: doc.partnerId ? { _id: doc.partnerId._id, name: doc.partnerId.name } : undefined,
        partnerId: doc.partnerId?._id,
        validityDays: doc.validityDays,
      } : null,
    };
  });

  const subtotal = round2(lines.filter((l) => l.available).reduce((n, l) => n + l.lineTotal, 0));
  return { lines, subtotal, itemCount: lines.filter((l) => l.available).reduce((n, l) => n + l.quantity, 0) };
}

const couponError = (message) => new ApiError(422, 'COUPON_INVALID', message, [{ path: 'code', message }]);

/**
 * Validates a coupon against priced cart lines for a user and returns the discount.
 * Throws a 422 COUPON_INVALID with a customer-friendly reason when it does not apply.
 */
async function evaluateCoupon(code, { lines, subtotal }, userId) {
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase() }).lean();
  const now = new Date();
  if (!coupon || coupon.status !== 'ACTIVE') throw couponError('This coupon code is not valid');
  if (coupon.validFrom > now) throw couponError('This coupon is not active yet');
  if (coupon.validTill < now) throw couponError('This coupon has expired');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw couponError('This coupon has reached its usage limit');
  if (subtotal < (coupon.minimumOrderValue || 0)) {
    throw couponError(`Add items worth at least ${coupon.minimumOrderValue} AED to use this coupon`);
  }
  if (userId) {
    const used = await Order.countDocuments({ userId, couponId: coupon._id, orderStatus: { $ne: 'CANCELLED' } });
    if (used >= (coupon.usagePerUser || 1)) throw couponError('You have already used this coupon');
  }

  const cats = new Set((coupon.applicableCategories || []).map(String));
  const prods = new Set((coupon.applicableProducts || []).map(String));
  const cities = new Set((coupon.applicableCities || []).map((c) => c.toLowerCase()));
  const restricted = cats.size > 0 || prods.size > 0;

  const eligible = lines.filter((l) => {
    if (!l.available) return false;
    if (l.itemType === 'GIFT_BOX') return !restricted && cities.size === 0;
    if (restricted && !cats.has(String(l.item.categoryId)) && !prods.has(String(l.productId))) return false;
    if (cities.size && !cities.has(String(l.item.city || '').toLowerCase())) return false;
    return true;
  });
  const eligibleTotal = round2(eligible.reduce((n, l) => n + l.lineTotal, 0));
  if (eligibleTotal <= 0) throw couponError('This coupon does not apply to the items in your cart');

  let discount = coupon.discountType === 'PERCENTAGE'
    ? (eligibleTotal * coupon.discountValue) / 100
    : coupon.discountValue;
  if (coupon.maximumDiscount != null) discount = Math.min(discount, coupon.maximumDiscount);
  discount = round2(Math.min(discount, eligibleTotal));

  return {
    coupon,
    discount,
    summary: {
      code: coupon.code, title: coupon.title, discountType: coupon.discountType, discountValue: coupon.discountValue,
      discount, eligibleSubtotal: eligibleTotal,
    },
  };
}

async function vatRate() {
  const s = await Setting.findOne({ key: 'store.vatRate' }).lean();
  const rate = Number(s?.value);
  return Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : 0.05;
}

/** Catalogue prices are VAT inclusive (UAE retail norm); taxTotal reports the VAT contained in the total. */
async function totals(subtotal, discount = 0) {
  const total = round2(Math.max(subtotal - discount, 0));
  const rate = await vatRate();
  return { subtotal, discountTotal: round2(discount), taxTotal: round2(total - total / (1 + rate)), total, vatRate: rate, pricesIncludeVat: true };
}

module.exports = { PRODUCT_CARD_FIELDS, GIFT_BOX_CARD_FIELDS, priceCart, evaluateCoupon, totals };
