const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { urlField, money, ref } = require('./_shared');

const giftBoxSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  price: money({ required: true }),
  salePrice: money(),
  currency: { type: String, default: 'AED', uppercase: true, minlength: 3, maxlength: 3 },
  coverImageUrl: urlField({ required: true }),
  productIds: {
    type: [ref('Product')],
    validate: [
      { validator: (v) => Array.isArray(v) && v.length >= 1, message: 'A gift box must contain at least one product' },
      { validator: (v) => new Set(v.map(String)).size === v.length, message: 'Duplicate products in gift box' },
    ],
  },
  validityDays: { type: Number, required: true, min: 1, max: 3650 },
  description: { type: String, trim: true, maxlength: 5000 },
  status: { type: String, enum: PUBLISH_STATUS, default: 'ACTIVE' },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

giftBoxSchema.index({ status: 1, createdAt: -1 });
giftBoxSchema.index({ productIds: 1 });

giftBoxSchema.pre('validate', function checkPrices(next) {
  if (this.salePrice != null && this.price != null && this.salePrice > this.price) {
    this.invalidate('salePrice', 'Sale price cannot be greater than price');
  }
  next();
});

module.exports = model('GiftBox', giftBoxSchema, 'giftBoxes');
