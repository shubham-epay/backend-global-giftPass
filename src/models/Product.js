const { Schema, model } = require('mongoose');
const { PRODUCT_STATUS } = require('../constants/enums');
const {
  urlArray, urlField, slugField, money, ref, seoFields,
} = require('./_shared');

const attributeSchema = new Schema({
  label: { type: String, required: true, trim: true, maxlength: 80 },
  value: { type: String, trim: true, maxlength: 500 },
  public: { type: Boolean, default: false },
}, { _id: false });

/** One sellable face value of a product, e.g. a 20 USD PlayStation card. Attributes hold per-value data such as margin. */
const denominationSchema = new Schema({
  value: money({ required: true }),
  price: money({ required: true }),
  oldPrice: money(),
  label: { type: String, trim: true, maxlength: 60 },
  img: urlField(),
  attributes: { type: [attributeSchema], default: [] },
}, { _id: false });

const productSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  slug: slugField(),
  categoryId: ref('Category', { required: true }),
  partnerId: ref('Partner', { required: true }),
  city: { type: String, trim: true, maxlength: 80 }, // optional: e.g. digital gift cards have no city
  country: { type: String, required: true, trim: true, maxlength: 80 },
  currency: { type: String, default: 'AED', uppercase: true, minlength: 3, maxlength: 3 },
  price: money({ required: true }),
  salePrice: money({ required: true }),
  // Open-amount products (e.g. an "AED 50–5,000" gift card): the customer chooses the value in this range.
  // price / salePrice then hold the lowest amount ("from" price).
  amountMin: money(),
  amountMax: money(),
  // Fixed face values the customer chooses from (e.g. 10 / 20 / 50 USD). price / salePrice mirror the highest one.
  denominations: { type: [denominationSchema], default: [] },
  // Where the product can be bought. Empty = available in every country.
  countries: { type: [ref('Country')], default: [] },
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
  // Extra data that only some catalogues have (e.g. "Delivery type", "Margin"). public=false stays in the admin.
  customFields: {
    type: [new Schema({
      key: { type: String, trim: true, maxlength: 80 },
      label: { type: String, required: true, trim: true, maxlength: 80 },
      value: { type: String, trim: true, maxlength: 500 },
      public: { type: Boolean, default: false },
    }, { _id: false })],
    default: [],
  },
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
productSchema.index({ status: 1, countries: 1 });
productSchema.index({ title: 'text', shortDescription: 'text' }, { weights: { title: 5, shortDescription: 1 } });

productSchema.pre('validate', function checkPrices(next) {
  if (this.price != null && this.salePrice != null && this.salePrice > this.price) {
    this.invalidate('salePrice', 'Sale price cannot be greater than price');
  }
  if (this.denominations?.length) {
    // Keep denominations sorted and unique; the product's own price is the highest one (shown on listings).
    const values = this.denominations.map((d) => d.value);
    if (new Set(values).size !== values.length) this.invalidate('denominations', 'Each denomination value can only appear once');
    this.denominations.sort((a, b) => a.value - b.value);
    const top = this.denominations[this.denominations.length - 1];
    this.salePrice = top.price;
    this.price = Math.max(top.oldPrice ?? top.price, top.price);
    if (this.amountMin != null || this.amountMax != null) this.invalidate('amountMin', 'A product has either denominations or an open amount, not both');
  }
  const hasMin = this.amountMin != null; const hasMax = this.amountMax != null;
  if (hasMin !== hasMax) this.invalidate(hasMin ? 'amountMax' : 'amountMin', 'Set both the minimum and maximum amount');
  if (hasMin && hasMax && this.amountMin > this.amountMax) this.invalidate('amountMax', 'Maximum amount must be at least the minimum');
  next();
});

module.exports = model('Product', productSchema);
