const { Schema, model } = require('mongoose');
const { PUBLISH_STATUS } = require('../constants/enums');
const { ref } = require('./_shared');

const faqSchema = new Schema({
  question: { type: String, required: true, trim: true, maxlength: 300 },
  answer: { type: String, required: true, trim: true, maxlength: 5000 },
  group: { type: String, trim: true, maxlength: 60, default: 'General' },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: PUBLISH_STATUS, default: 'ACTIVE' },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

faqSchema.index({ status: 1, group: 1, sortOrder: 1 });

module.exports = model('Faq', faqSchema);
