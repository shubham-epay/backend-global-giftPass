const { Schema, model } = require('mongoose');
const { ref } = require('./_shared');

const settingSchema = new Schema({
  key: { type: String, required: true, trim: true, maxlength: 80, match: /^[a-zA-Z0-9_.]+$/ },
  value: { type: Schema.Types.Mixed },
  description: { type: String, maxlength: 300 },
  isPublic: { type: Boolean, default: false }, // exposed to storefront if true
  updatedBy: ref('User'),
}, { timestamps: true });

settingSchema.index({ key: 1 }, { unique: true });

module.exports = model('Setting', settingSchema);
