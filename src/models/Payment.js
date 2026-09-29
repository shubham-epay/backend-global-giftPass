const { Schema, model } = require('mongoose');
const { PAYMENT_STATUS } = require('../constants/enums');
const { money, ref } = require('./_shared');

const paymentEventSchema = new Schema({
  type: { type: String, required: true, maxlength: 80 },
  providerEventId: { type: String, maxlength: 200 },
  status: { type: String, enum: PAYMENT_STATUS },
  amount: money(),
  at: { type: Date, default: Date.now },
}, { _id: false });

const paymentSchema = new Schema({
  orderId: ref('Order', { required: true }),
  provider: { type: String, required: true, trim: true, maxlength: 40 },   // e.g. EPAYME, GEIDEA, STRIPE
  providerReference: { type: String, trim: true, maxlength: 200 },          // PSP transaction / intent id
  method: { type: String, trim: true, maxlength: 40 },                      // CARD, APPLE_PAY ...
  cardLast4: { type: String, match: /^\d{4}$/ },                            // never store PAN/CVV (PCI DSS)
  cardBrand: { type: String, maxlength: 20 },
  amount: money({ required: true }),
  currency: { type: String, default: 'AED', uppercase: true },
  status: { type: String, enum: PAYMENT_STATUS, default: 'PENDING' },
  refundedAmount: money({ default: 0 }),
  failureReason: { type: String, maxlength: 500 },
  events: { type: [paymentEventSchema], default: [] },
  processedEventIds: { type: [String], default: [], select: false },       // webhook idempotency
}, { timestamps: true });

paymentSchema.index({ orderId: 1 });
paymentSchema.index({ provider: 1, providerReference: 1 }, { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } } });
paymentSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Payment', paymentSchema);
