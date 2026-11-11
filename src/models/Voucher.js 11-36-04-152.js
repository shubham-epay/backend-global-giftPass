const { Schema, model } = require('mongoose');
const { VOUCHER_STATUS } = require('../constants/enums');
const { money, ref } = require('./_shared');

const voucherSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true },
  orderId: ref('Order', { required: true }),
  orderItemId: ref('OrderItem'),
  productId: ref('Product'),
  giftBoxId: ref('GiftBox'),
  value: money(),
  currency: { type: String, default: 'AED', uppercase: true },

  recipientName: { type: String, required: true, trim: true, maxlength: 120 },
  recipientEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  recipientPhone: { type: String, trim: true, maxlength: 30 },
  senderName: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, trim: true, maxlength: 1000 },

  expiryDate: { type: Date, required: true },
  status: { type: String, enum: VOUCHER_STATUS, default: 'ACTIVE' },
  issuedAt: { type: Date, default: Date.now },
  sentAt: Date,
  redeemedAt: Date,
  redeemedAtPartnerId: ref('Partner'),
  exchangedToVoucherId: ref('Voucher'),
  cancelledAt: Date,
  statusReason: { type: String, trim: true, maxlength: 500 },
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });

voucherSchema.index({ code: 1 }, { unique: true });
voucherSchema.index({ orderId: 1 });
voucherSchema.index({ status: 1, expiryDate: 1 });
voucherSchema.index({ recipientEmail: 1 });

module.exports = model('Voucher', voucherSchema);
