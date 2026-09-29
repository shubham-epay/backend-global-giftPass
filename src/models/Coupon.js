const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS, DISCOUNT_TYPES } = require('../constants/enums');
const { money, ref } = require('./_shared');

const couponSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40, match: [/^[A-Z0-9_-]{3,40}$/, 'Code may contain A-Z, 0-9, _ and -'] },
  discountType: { type: String, enum: DISCOUNT_TYPES, required: true },
  discountValue: { type: Number, required: true, min: 0.01 },
  validFrom: { type: Date, required: true },
  validTill: { type: Date, required: true },
  status: { type: String, enum: PUBLISH_STATUS, required: true, default: 'ACTIVE' },

  minimumOrderValue: money({ default: 0 }),
  maximumDiscount: money(),
  usageLimit: { type: Number, min: 1 },          // total redemptions across all users
  usagePerUser: { type: Number, min: 1, default: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  applicableCategories: { type: [ref('Category')], default: [] },
  applicableProducts: { type: [ref('Product')], default: [] },
  applicableCities: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
  description: { type: String, trim: true, maxlength: 1000 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ status: 1, validFrom: 1, validTill: 1 });

couponSchema.pre('validate', function checkCoupon(next) {
  if (this.validFrom && this.validTill && this.validTill <= this.validFrom) {
    this.invalidate('validTill', 'Valid till must be after valid from');
  }
  if (this.discountType === 'PERCENTAGE' && this.discountValue > 100) {
    this.invalidate('discountValue', 'Percentage discount cannot exceed 100');
  }
  if (this.usageLimit != null && this.usedCount > this.usageLimit) {
    this.invalidate('usageLimit', `Usage limit cannot be below times already used (${this.usedCount})`);
  }
  next();
});

couponSchema.virtual('isCurrentlyValid').get(function isCurrentlyValid() {
  const now = new Date();
  return this.status === 'ACTIVE' && this.validFrom <= now && this.validTill >= now
    && (this.usageLimit == null || this.usedCount < this.usageLimit);
});

module.exports = model('Coupon', couponSchema);
