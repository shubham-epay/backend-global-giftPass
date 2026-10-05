const { Schema, model } = require('mongoose');
const { ITEM_TYPES } = require('../constants/enums');
const { money, ref } = require('./_shared');

const cartItemSchema = new Schema({
  itemType: { type: String, enum: ITEM_TYPES, required: true },
  productId: ref('Product'),
  giftBoxId: ref('GiftBox'),
  quantity: { type: Number, required: true, min: 1, max: 100, default: 1 },
  unitPriceSnapshot: money(),
  amount: money(), // chosen value for open-amount products
  recipient: { name: String, email: String, phone: String },
  message: { type: String, maxlength: 1000 },
}, { _id: true, timestamps: true });

// Signed-in customers own one cart by userId. Guests get a cart addressed by a random token that only
// the browser holds (we store its SHA-256); guest carts expire after 30 days without changes.
const GUEST_CART_TTL_DAYS = 30;

const cartSchema = new Schema({
  userId: ref('User'),
  guestTokenHash: { type: String, select: false },
  expiresAt: Date,
  items: { type: [cartItemSchema], default: [] },
  couponCode: { type: String, trim: true, uppercase: true },
}, { timestamps: true });

cartSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
cartSchema.index({ guestTokenHash: 1 }, { unique: true, partialFilterExpression: { guestTokenHash: { $type: 'string' } } });
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

cartSchema.pre('save', function touchGuestExpiry(next) {
  if (!this.userId) this.expiresAt = new Date(Date.now() + GUEST_CART_TTL_DAYS * 864e5);
  else this.expiresAt = undefined;
  next();
});

module.exports = model('Cart', cartSchema, 'cart');
