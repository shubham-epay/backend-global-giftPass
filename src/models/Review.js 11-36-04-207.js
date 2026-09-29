const { Schema, model } = require('mongoose');
const { REVIEW_STATUS } = require('../constants/enums');
const { ref } = require('./_shared');

const reviewSchema = new Schema({
  userId: ref('User', { required: true }),
  productId: ref('Product', { required: true }),
  orderId: ref('Order'),
  rating: { type: Number, required: true, min: 1, max: 5 },
  title: { type: String, trim: true, maxlength: 120 },
  comment: { type: String, trim: true, maxlength: 3000 },
  status: { type: String, enum: REVIEW_STATUS, default: 'PENDING' },
  moderatedBy: ref('User'),
  moderatedAt: Date,
}, { timestamps: true });

reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ userId: 1, productId: 1 }, { unique: true }); // one review per product per customer

module.exports = model('Review', reviewSchema);
