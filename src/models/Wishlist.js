const { Schema, model } = require('mongoose');
const { ref } = require('./_shared');

const wishlistSchema = new Schema({
  userId: ref('User', { required: true }),
  items: {
    type: [new Schema({ productId: ref('Product', { required: true }), addedAt: { type: Date, default: Date.now } }, { _id: false })],
    default: [],
  },
}, { timestamps: true });

wishlistSchema.index({ userId: 1 }, { unique: true });

module.exports = model('Wishlist', wishlistSchema, 'wishlist');
