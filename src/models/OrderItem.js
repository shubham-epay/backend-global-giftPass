const { Schema, model } = require('mongoose');
const { ITEM_TYPES } = require('../constants/enums');
const { money, ref, urlField } = require('./_shared');

const orderItemSchema = new Schema({
  orderId: ref('Order', { required: true }),
  itemType: { type: String, enum: ITEM_TYPES, required: true },
  productId: ref('Product', { required: function r() { return this.itemType === 'PRODUCT'; } }),
  giftBoxId: ref('GiftBox', { required: function r() { return this.itemType === 'GIFT_BOX'; } }),
  // Snapshots, so historical orders stay correct after catalogue edits.
  titleSnapshot: { type: String, required: true, trim: true, maxlength: 200 },
  imageUrlSnapshot: urlField(),
  partnerId: ref('Partner'),
  unitPrice: money({ required: true }),
  quantity: { type: Number, required: true, min: 1, max: 100 },
  lineTotal: money({ required: true }),
  recipient: {
    name: { type: String, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30 },
  },
  senderName: { type: String, trim: true, maxlength: 120 },
  message: { type: String, trim: true, maxlength: 1000 },
  scheduledDeliveryAt: Date,
}, { timestamps: true });

orderItemSchema.index({ orderId: 1 });
orderItemSchema.index({ productId: 1 });
orderItemSchema.index({ giftBoxId: 1 });

module.exports = model('OrderItem', orderItemSchema, 'orderItems');
