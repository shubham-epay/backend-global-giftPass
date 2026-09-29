const { Schema, model } = require('mongoose');
const { ITEM_TYPES } = require('../constants/enums');
const { money, ref } = require('./_shared');

const cartItemSchema = new Schema({
  itemType: { type: String, enum: ITEM_TYPES, required: true },
  productId: ref('Product'),
  giftBoxId: ref('GiftBox'),
  quantity: { type: Number, required: true, min: 1, max: 100, default: 1 },
  unitPriceSnapshot: money(),
  recipient: { name: String, email: String, phone: String },
  message: { type: String, maxlength: 1000 },
}, { _id: true, timestamps: true });

const cartSchema = new Schema({
  userId: ref('User', { required: true }),
  items: { type: [cartItemSchema], default: [] },
  couponCode: { type: String, trim: true, uppercase: true },
}, { timestamps: true });

cartSchema.index({ userId: 1 }, { unique: true });

module.exports = model('Cart', cartSchema, 'cart');
