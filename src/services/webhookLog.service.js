const config = require('../config/env');
const { WebhookLog } = require('../models');

const RAW_LIMIT = 64 * 1024;        // accepted deliveries
const REJECTED_RAW_LIMIT = 8 * 1024; // unauthenticated senders get less room

/** Headers as received, minus anything that is a credential. The signature is a MAC, not a secret, so it stays. */
function safeHeaders(req) {
  const secret = new Set(['authorization', 'cookie', 'proxy-authorization', String(config.SYNRAPAY_WEBHOOK_KEY_NAME || '').toLowerCase()]);
  return Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, secret.has(k.toLowerCase()) ? '[redacted]' : String(v).slice(0, 500)]));
}

/**
 * Searchable fields copied out of a SynraPay payload. Hosted/Session deliveries use orderId, the Direct API
 * merchant_order_id, and payment link deliveries nest everything under paymentLink / order / payment.
 */
function summarise(body = {}) {
  const link = body.paymentLink || {};
  const order = body.order || {};
  const pay = body.payment || {};
  const referenceId = link.referenceId ? String(link.referenceId).slice(0, 100) : undefined;
  const merchantOrderId = String(body.orderId || body.merchant_order_id || referenceId || order.orderId || '').slice(0, 100) || undefined;
  const amount = Number(body.amount ?? body.captured_amount ?? order.amount ?? link.amount);
  const currency = body.currency || order.currency || link.currency;
  return {
    merchantOrderId,
    referenceId,
    orderNumber: merchantOrderId ? merchantOrderId.replace(/-P\d+$/i, '') : undefined,
    transactionId: String(body.transactionId || body.transaction_id || body.order_id || order.transactionId || '').slice(0, 200) || undefined,
    paymentLinkId: body.paymentLinkId || link.paymentLinkId ? String(body.paymentLinkId || link.paymentLinkId).slice(0, 100) : undefined,
    providerStatus: String(body.status || body.order_status || '').slice(0, 40) || undefined,
    detailedStatus: body.detailedStatus || pay.codes?.status ? String(body.detailedStatus || pay.codes.status).slice(0, 40) : undefined,
    code: body.code || pay.codes?.code ? String(body.code || pay.codes.code).slice(0, 20) : undefined,
    reason: body.reason || pay.codes?.reason ? String(body.reason || pay.codes.reason).slice(0, 80) : undefined,
    message: body.message || pay.codes?.message ? String(body.message || pay.codes.message).slice(0, 300) : undefined,
    cardBrand: body.paymentMethod?.brand || pay.card?.brand ? String(body.paymentMethod?.brand || pay.card.brand).slice(0, 20) : undefined,
    cardLast4: (String(body.paymentMethod?.maskedCardNumber || pay.card?.last4 || '').match(/(\d{4})$/) || [])[1],
    refundedTotal: Number.isFinite(Number(body.refund?.refundedTotal)) ? Number(body.refund.refundedTotal) : undefined,
    amount: Number.isFinite(amount) ? amount : undefined,
    currency: typeof currency === 'string' ? currency.slice(0, 3) : undefined,
  };
}

/** x-synrapay-timestamp (Unix seconds; milliseconds tolerated) as a date. */
function sentAtOf(req) {
  const n = Number(req.get('x-synrapay-timestamp'));
  const d = new Date(n > 1e12 ? n : n * 1000);
  return Number.isFinite(n) && n > 0 && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** The signed body as an object, so it reads as a document in the database. Text only when it isn't JSON or is over the cap. */
function rawBodyOf(req, rawLimit) {
  if (typeof req.rawBody !== 'string') return undefined;
  if (req.rawBody.length <= rawLimit) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not JSON: keep the text */ }
  }
  return req.rawBody.slice(0, rawLimit);
}

const requestFields = (req, rawLimit) => ({
  event: (req.get('x-synrapay-event') || '').slice(0, 80) || undefined,
  signatureTimestamp: (req.get('x-synrapay-timestamp') || '').slice(0, 40) || undefined,
  sentAt: sentAtOf(req),
  signatureVersion: (req.get('x-synrapay-signature-version') || '').slice(0, 10) || undefined,
  requestId: req.id,
  ip: req.ip,
  userAgent: (req.get('user-agent') || '').slice(0, 300) || undefined,
  headers: safeHeaders(req),
  rawBody: rawBodyOf(req, rawLimit),
});

/**
 * Stores a verified delivery (one document per distinct delivery; retries bump `deliveries`).
 * Never throws: failing to log must not stop the webhook being processed.
 * @returns the log document's _id, or null
 */
async function recordAccepted(req, provider = 'SYNRAPAY') {
  try {
    const now = new Date();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const doc = await WebhookLog.findOneAndUpdate(
      { provider, deliveryId: req.webhookDeliveryId, verified: true },
      {
        $setOnInsert: {
          provider, deliveryId: req.webhookDeliveryId, verified: true, firstReceivedAt: now, processing: 'RECEIVED',
          ...requestFields(req, RAW_LIMIT), payload: body, ...summarise(body),
        },
        $set: { lastReceivedAt: now },
        $inc: { deliveries: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false },
    ).select('_id');
    return doc._id;
  } catch (err) {
    console.error('[webhook] could not store delivery:', err.message);
    return null;
  }
}

/** Stores a delivery that failed verification. Its payload is untrusted and only kept for diagnosis. */
function recordRejected(req, reason, provider = 'SYNRAPAY') {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  WebhookLog.create({
    provider, verified: false, rejectReason: reason, processing: 'REJECTED', outcome: 'rejected before processing', deliveries: 1,
    ...requestFields(req, REJECTED_RAW_LIMIT), ...summarise(body),
  }).catch((err) => console.error('[webhook] could not store rejected delivery:', err.message));
}

/** Records what processing did with a stored delivery. */
async function recordOutcome(logId, { processing, outcome, error, payment, order, startedAt }) {
  if (!logId) return;
  await WebhookLog.updateOne({ _id: logId }, {
    processing,
    outcome: outcome ? String(outcome).slice(0, 200) : undefined,
    error: error ? String(error.stack || error.message || error).slice(0, 1000) : undefined,
    paymentId: payment?._id,
    orderId: order?._id || payment?.orderId,
    processedAt: new Date(),
    processingMs: startedAt ? Date.now() - startedAt : undefined,
  }).catch((err) => console.error('[webhook] could not store outcome:', err.message));
}

module.exports = { recordAccepted, recordRejected, recordOutcome };
