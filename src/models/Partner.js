const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { urlField, urlArray, ref } = require('./_shared');

const partnerSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  city: { type: String, required: true, trim: true, maxlength: 80 },
  country: { type: String, required: true, trim: true, maxlength: 80 },
  address: { type: String, required: true, trim: true, maxlength: 400 },
  status: { type: String, enum: PUBLISH_STATUS, required: true, default: 'ACTIVE' },
  website: urlField(),
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 30 },
  logoUrl: urlField(),
  coverImageUrl: urlField(),
  galleryUrls: urlArray(),
  workingHours: { type: String, trim: true, maxlength: 500 },
  description: { type: String, trim: true, maxlength: 5000 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

partnerSchema.index({ status: 1, city: 1 });
partnerSchema.index({ name: 1 });

module.exports = model('Partner', partnerSchema);
