const { Schema, model } = require('mongoose');
const { ref } = require('./_shared');

/**
 * Every webhook delivery we receive, accepted or rejected, exactly as it arrived - collection `webhook`.
 * A payment that completes without a webhook reaching us is recorded here too (see `source`), so every
 * finished payment has an entry.
 * It is the audit trail for "what did the provider tell us, and what did we do with it".
 * Secrets are never stored: the API-key header and cookies/authorization are redacted.
 */
const webhookLogSchema = new Schema({
  provider: { type: String, required: true, trim: true, maxlength: 40 },   // SYNRAPAY
  // Where this record came from:
  //  WEBHOOK    - a delivery SynraPay sent to our endpoint
  //  GET_STATUS - written by us when Get Status reported a final result (webhook late, lost or unreachable)
  //  DIRECT_API - written by us from the Direct API payment response
  source: { type: String, enum: ['WEBHOOK', 'GET_STATUS', 'DIRECT_API'], default: 'WEBHOOK' },
  event: { type: String, trim: true, maxlength: 80 },                      // x-synrapay-event, e.g. payment.succeeded
  // SHA-256 of event + raw body. Provider retries resend the same body, so they share one document.
  deliveryId: { type: String, maxlength: 64 },
  deliveries: { type: Number, default: 1 },                                // times this exact delivery arrived
  firstReceivedAt: { type: Date, default: Date.now },
  lastReceivedAt: { type: Date, default: Date.now },

  // Verification
  verified: { type: Boolean, required: true },                             // signature + API key accepted
  rejectReason: { type: String, maxlength: 120 },                          // why it was refused (verified: false)
  signatureTimestamp: { type: String, maxlength: 40 },                     // x-synrapay-timestamp as sent

  // Request, as received
  requestId: { type: String, maxlength: 64 },
  ip: { type: String, maxlength: 64 },
  userAgent: { type: String, maxlength: 300 },
  headers: { type: Schema.Types.Mixed },                                   // redacted copy
  payload: { type: Schema.Types.Mixed },                                   // parsed JSON body
  rawBody: { type: String },                                               // exact bytes that were signed (capped)

  // What the delivery is about (copied out of the payload for searching)
  merchantOrderId: { type: String, trim: true, maxlength: 100 },           // our attempt id, e.g. GGP-261005-ABC123-P1
  orderNumber: { type: String, trim: true, uppercase: true, maxlength: 40 },
  transactionId: { type: String, trim: true, maxlength: 200 },
  paymentLinkId: { type: String, trim: true, maxlength: 100 },
  providerStatus: { type: String, trim: true, maxlength: 40 },             // success | failed | cancelled | refunded ...
  detailedStatus: { type: String, trim: true, maxlength: 40 },             // SUCCESS | DECLINED | BLOCKED | EXPIRED ...
  code: { type: String, trim: true, maxlength: 20 },                       // SynraPay outcome code, e.g. 700.511
  reason: { type: String, trim: true, maxlength: 80 },                     // code name, e.g. FUNDS_TOO_LOW
  message: { type: String, trim: true, maxlength: 300 },                   // payer-safe wording
  cardBrand: { type: String, trim: true, maxlength: 20 },
  cardLast4: { type: String, maxlength: 4 },                               // from the already-masked number
  refundedTotal: { type: Number },                                         // refund.succeeded: cumulative
  signatureVersion: { type: String, maxlength: 10 },                       // x-synrapay-signature-version
  amount: { type: Number },
  currency: { type: String, uppercase: true, maxlength: 3 },
  paymentId: ref('Payment'),
  orderId: ref('Order'),

  // What we did with it
  processing: { type: String, enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED'], default: 'RECEIVED' },
  outcome: { type: String, maxlength: 200 },                               // e.g. "payment PAID, order PAID" / "duplicate"
  error: { type: String, maxlength: 1000 },
  processedAt: Date,
  processingMs: Number,
}, { timestamps: true, minimize: false });

webhookLogSchema.index({ provider: 1, deliveryId: 1 }, { unique: true, partialFilterExpression: { verified: true, deliveryId: { $type: 'string' } } });
webhookLogSchema.index({ merchantOrderId: 1, createdAt: -1 });
webhookLogSchema.index({ orderNumber: 1, createdAt: -1 });
webhookLogSchema.index({ transactionId: 1 }, { sparse: true });
webhookLogSchema.index({ processing: 1, createdAt: -1 });
webhookLogSchema.index({ source: 1, createdAt: -1 });
webhookLogSchema.index({ createdAt: -1 });

module.exports = model('WebhookLog', webhookLogSchema, 'webhook');
