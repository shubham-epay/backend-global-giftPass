const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { urlField, slugField, ref, seoFields } = require('./_shared');

const categorySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: slugField(),
  status: { type: String, enum: PUBLISH_STATUS, required: true, default: 'ACTIVE' },
  description: { type: String, trim: true, maxlength: 2000 },
  iconUrl: urlField(),
  bannerUrl: urlField(),
  parentCategoryId: ref('Category', { default: null }),
  sortOrder: { type: Number, default: 0 },
  ...seoFields,
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ status: 1, sortOrder: 1 });
categorySchema.index({ parentCategoryId: 1 });

categorySchema.pre('validate', function preventSelfParent(next) {
  if (this.parentCategoryId && this._id && this.parentCategoryId.equals(this._id)) {
    this.invalidate('parentCategoryId', 'A category cannot be its own parent');
  }
  next();
});

module.exports = model('Category', categorySchema);
