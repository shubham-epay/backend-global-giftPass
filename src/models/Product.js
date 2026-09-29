const { Schema, model } = require('mongoose');
const { PRODUCT_STATUS } = require('../constants/enums');
const { urlArray, slugField, money, ref, seoFields } = require('./_shared');

const productSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  slug: slugField(),
  categoryId: ref('Category', { required: true }),
  partnerId: ref('Partner', { required: true }),
  city: { type: String, required: true, trim: true, maxlength: 80 },
  country: { type: String, required: true, trim: true, maxlength: 80 },
  currency: { type: String, default: 'AED', uppercase: true, minlength: 3, maxlength: 3 },
  price: money({ required: true }),
  salePrice: money({ required: true }),
  duration: { type: String, required: true, trim: true, maxlength: 60 }, // e.g. "90 minutes", "Full day"
  validityDays: { type: Number, required: true, min: 1, max: 3650 },
  imageUrls: { ...urlArray(), validate: { validator: (v) => v.length >= 1 && v.length <= 20, message: 'Provide between 1 and 20 image URLs' } },
  status: { type: String, enum: PRODUCT_STATUS, required: true, default: 'DRAFT' },

  galleryUrls: urlArray(),
  featured: { type: Boolean, default: false },
  bestSeller: { type: Boolean, default: false },
  flashSale: { type: Boolean, default: false },
  peopleCount: { type: Number, min: 1, max: 100 },
  shortDescription: { type: String, trim: true, maxlength: 500 },
  description: { type: String, trim: true, maxlength: 20000 },
  termsConditions: { type: String, trim: true, maxlength: 20000 },
  // Voucher page content blocks
  whatsIncluded: { type: [{ type: String, trim: true, maxlength: 500 }], default: [] },
  whatsNotIncluded: { type: [{ type: String, trim: true, maxlength: 500 }], default: [] },
  howToUse: { type: [{ type: String, trim: true, maxlength: 2000 }], default: [] },
  importantInstructions: { type: [{ type: String, trim: true, maxlength: 2000 }], default: [] },
  packageDetails: {
    type: [new Schema({ label: { type: String, trim: true, maxlength: 80 }, value: { type: String, trim: true, maxlength: 300 } }, { _id: false })],
    default: [],
  },
  legalNote: { type: String, trim: true, maxlength: 3000 },
  supplierReference: { type: String, trim: true, maxlength: 120 },
  apiDeliveryId: { type: String, trim: true, maxlength: 120 },
  ...seoFields,

  ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
  ratingCount: { type: Number, default: 0, min: 0 },
  soldCount: { type: Number, default: 0, min: 0 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ status: 1, categoryId: 1, createdAt: -1 });
productSchema.index({ status: 1, featured: 1 });
productSchema.index({ status: 1, bestSeller: 1 });
productSchema.index({ status: 1, flashSale: 1 });
productSchema.index({ partnerId: 1 });
productSchema.index({ city: 1, country: 1 });
productSchema.index({ title: 'text', shortDescription: 'text' }, { weights: { title: 5, shortDescription: 1 } });

productSchema.pre('validate', function checkPrices(next) {
  if (this.price != null && this.salePrice != null && this.salePrice > this.price) {
    this.invalidate('salePrice', 'Sale price cannot be greater than price');
  }
  next();
});

module.exports = model('Product', productSchema);
