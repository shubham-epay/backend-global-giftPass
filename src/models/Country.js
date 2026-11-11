const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { ref } = require('./_shared');
const { findIsoCountry, flagOf } = require('../constants/countries');

/**
 * Countries products can be sold in. status ACTIVE = shown in the storefront country picker and its
 * products are visible; INACTIVE hides the country (and products available only there).
 */
const countrySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  code: { type: String, trim: true, uppercase: true, match: [/^[A-Z]{2}$/, 'Use a 2-letter ISO code such as AE'] },
  currency: { type: String, trim: true, uppercase: true, match: [/^[A-Z]{3}$/, 'Use a 3-letter currency code'] },
  flag: { type: String, trim: true, maxlength: 16 },
  status: { type: String, enum: PUBLISH_STATUS, required: true, default: 'ACTIVE' },
  sortOrder: { type: Number, default: 0 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

countrySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
countrySchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
countrySchema.index({ status: 1, sortOrder: 1, name: 1 });

// Fill ISO code, currency and flag from the name when they are not given.
countrySchema.pre('validate', function fillFromIso(next) {
  const iso = findIsoCountry(this.code) || findIsoCountry(this.name);
  if (iso) {
    if (!this.code) this.code = iso.code;
    if (!this.currency) this.currency = iso.currency;
  }
  if (!this.code) this.code = undefined;
  this.flag = flagOf(this.code) || undefined;
  next();
});

// The storefront caches the active-country list; drop it whenever a country changes.
// (Required lazily inside the hook to avoid a load-time cycle with the models index.)
const invalidate = () => require('../services/countryScope.service').invalidateCountryCache();
countrySchema.post('save', invalidate);
countrySchema.post('deleteOne', { document: true, query: false }, invalidate);
countrySchema.post(['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteMany'], invalidate);

module.exports = model('Country', countrySchema);
