const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { urlField, slugField, ref } = require('./_shared');

// Curated product collections for the storefront (e.g. "Date night", "For her").
const collectionSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  slug: slugField(),
  description: { type: String, trim: true, maxlength: 2000 },
  imageUrl: urlField(),
  productIds: { type: [ref('Product')], default: [] },
  status: { type: String, enum: PUBLISH_STATUS, default: 'ACTIVE' },
  showOnHome: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

collectionSchema.index({ slug: 1 }, { unique: true });
collectionSchema.index({ status: 1, showOnHome: 1, sortOrder: 1 });

module.exports = model('CuratedCollection', collectionSchema, 'collections');
