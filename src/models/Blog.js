const { Schema, model } = require('mongoose');
const { BLOG_STATUS } = require('../constants/enums');
const { urlField, slugField, ref, seoFields } = require('./_shared');

const blogSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  slug: slugField(),
  excerpt: { type: String, trim: true, maxlength: 500 },
  content: { type: String, required: true, maxlength: 100000 },
  coverImageUrl: urlField(),
  authorName: { type: String, trim: true, maxlength: 120 },
  tags: { type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }], default: [] },
  status: { type: String, enum: BLOG_STATUS, default: 'DRAFT' },
  publishedAt: Date,
  ...seoFields,
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

blogSchema.index({ slug: 1 }, { unique: true });
blogSchema.index({ status: 1, publishedAt: -1 });
blogSchema.index({ tags: 1 });

blogSchema.pre('save', function setPublishedAt(next) {
  if (this.isModified('status') && this.status === 'PUBLISHED' && !this.publishedAt) this.publishedAt = new Date();
  next();
});

module.exports = model('Blog', blogSchema);
