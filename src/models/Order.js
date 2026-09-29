const { Schema, model } = require('mongoose');
const { ORDER_STATUS, PAYMENT_STATUS } = require('../constants/enums');
const { money, ref, addressSchema } = require('./_shared');

const statusHistorySchema = new Schema({
  from: { type: String, enum: ORDER_STATUS },
  to: { type: String, enum: ORDER_STATUS, required: true },
  note: { type: String, trim: true, maxlength: 1000 },
  changedBy: ref('User'),
  source: { type: String, enum: ['ADMIN', 'SYSTEM', 'WEBHOOK', 'CUSTOMER'], default: 'SYSTEM' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const orderSchema = new Schema({
  orderNumber: { type: String, required: true, trim: true, uppercase: true },
  userId: ref('User', { required: true }),
  customer: {
    name: { type: String, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30 },
  },
  itemCount: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'AED', uppercase: true },
  subtotal: money({ required: true }),
  discountTotal: money({ default: 0 }),
  taxTotal: money({ default: 0 }),       // UAE VAT
  total: money({ required: true }),
  couponId: ref('Coupon'),
  couponCode: { type: String, trim: true, uppercase: true },

  orderStatus: { type: String, enum: ORDER_STATUS, default: 'PENDING' },
  paymentStatus: { type: String, enum: PAYMENT_STATUS, default: 'PENDING' },
  paymentId: ref('Payment'),
  statusHistory: { type: [statusHistorySchema], default: [] },

  deliveryMethod: { type: String, enum: ['EMAIL', 'SMS', 'PHYSICAL'], default: 'EMAIL' },
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  trackingNumber: { type: String, trim: true, maxlength: 120 },
  notes: { type: String, trim: true, maxlength: 2000 }, // internal admin notes
  placedAt: { type: Date, default: Date.now },
  paidAt: Date,
  cancelledAt: Date,
  refundedAt: Date,
}, { timestamps: true });

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ 'customer.email': 1 });

module.exports = model('Order', orderSchema);
