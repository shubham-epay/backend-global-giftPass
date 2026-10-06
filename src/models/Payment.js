const { Schema, model } = require('mongoose');
const { PAYMENT_STATUS, PAYMENT_LINK_TYPES, DIRECT_CAPTURE_MODES } = require('../constants/enums');
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
  provider: { type: String, required: true, trim: true, maxlength: 40 },   // e.g. SYNRAPAY, EPAYME, GEIDEA
  // The orderId sent to the provider for this attempt (order number + attempt, e.g. GGP-261003-ABC123-P1).
  merchantOrderId: { type: String, trim: true, maxlength: 100 },
  providerReference: { type: String, trim: true, maxlength: 200 },          // PSP transaction / intent id
  method: { type: String, trim: true, maxlength: 40 },                      // CARD, APPLE_PAY ...
  cardLast4: { type: String, match: /^\d{4}$/ },                            // never store PAN/CVV (PCI DSS)
  cardBrand: { type: String, maxlength: 20 },
  amount: money({ required: true }),
  currency: { type: String, default: 'AED', uppercase: true },
  status: { type: String, enum: PAYMENT_STATUS, default: 'PENDING' },
  refundedAmount: money({ default: 0 }),
  failureReason: { type: String, maxlength: 500 },
  // SynraPay attempt details (no card data). Hosted Session / Pay By Link / Hosted Checkout.
  session: {
    sessionId: { type: String, maxlength: 200 },
    expiresAt: Date,
    fallbackCheckoutUrl: { type: String, maxlength: 2048 },
  },
  link: {
    kind: { type: String, enum: PAYMENT_LINK_TYPES },
    paymentLinkId: { type: String, maxlength: 100 },
    url: { type: String, maxlength: 2048 },
    status: { type: String, maxlength: 20 }, // ACTIVE | SUCCESS | EXPIRED | DEACTIVATED | DELETED
    expiresAt: Date,
  },
  checkoutUrl: { type: String, maxlength: 2048 },
  // Direct API attempt. Only SynraPay's order id and progress flags - never the card number or CVV.
  direct: {
    orderId: { type: String, maxlength: 64 },   // SynraPay order_id (UUID) from /direct/create-order
    captureMode: { type: String, enum: DIRECT_CAPTURE_MODES }, // AUTHORIZE: held until an admin captures; CAPTURE: taken at once
    attempted: { type: Boolean, default: false }, // a card was submitted (an order can be paid only once)
    challenge: { type: Boolean, default: false }, // waiting for the shopper to finish 3-D Secure
  },
  // Get Status polling (paymentReconciler): last raw provider status and when we last asked.
  providerStatus: { type: String, maxlength: 40 },
  statusCheckedAt: Date,
  statusChecks: { type: Number, default: 0 },
  reviewRequired: { type: Boolean, default: false }, // provider amount/currency didn't match the order
  events: { type: [paymentEventSchema], default: [] },
  processedEventIds: { type: [String], default: [], select: false },       // webhook idempotency
}, { timestamps: true });

paymentSchema.index({ orderId: 1, createdAt: -1 });
paymentSchema.index({ provider: 1, merchantOrderId: 1 }, { unique: true, partialFilterExpression: { merchantOrderId: { $type: 'string' } } });
paymentSchema.index({ 'link.paymentLinkId': 1 }, { sparse: true });
paymentSchema.index({ provider: 1, providerReference: 1 }, { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } } });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ provider: 1, status: 1, statusCheckedAt: 1 });

module.exports = model('Payment', paymentSchema);
