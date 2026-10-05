const crypto = require('crypto');
const config = require('../config/env');
const { WebhookLog } = require('../models');

const RAW_LIMIT = 64 * 1024;        // accepted deliveries
const REJECTED_RAW_LIMIT = 8 * 1024; // unauthenticated senders get less room

/** Headers as received, minus anything that is a credential. The signature is a MAC, not a secret, so it stays. */
function safeHeaders(req) {
  const secret = new Set(['authorization', 'cookie', 'proxy-authorization', String(config.SYNRAPAY_WEBHOOK_KEY_NAME || '').toLowerCase()]);
  return Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, secret.has(k.toLowerCase()) ? '[redacted]' : String(v).slice(0, 500)]));
}

/** Searchable fields copied out of a SynraPay payload (Hosted/Link use orderId, Direct API merchant_order_id). */
function summarise(body = {}) {
  const merchantOrderId = String(body.orderId || body.merchant_order_id || '').slice(0, 100) || undefined;
  const amount = Number(body.amount ?? body.captured_amount);
  return {
    merchantOrderId,
    orderNumber: merchantOrderId ? merchantOrderId.replace(/-P\d+$/i, '') : undefined,
    transactionId: String(body.transactionId || body.transaction_id || body.order_id || '').slice(0, 200) || undefined,
    paymentLinkId: body.paymentLinkId ? String(body.paymentLinkId).slice(0, 100) : undefined,
    providerStatus: String(body.status || body.order_status || '').slice(0, 40) || undefined,
    detailedStatus: body.detailedStatus ? String(body.detailedStatus).slice(0, 40) : undefined,
    code: body.code ? String(body.code).slice(0, 20) : undefined,
    reason: body.reason ? String(body.reason).slice(0, 80) : undefined,
    message: body.message ? String(body.message).slice(0, 300) : undefined,
    cardBrand: body.paymentMethod?.brand ? String(body.paymentMethod.brand).slice(0, 20) : undefined,
    cardLast4: (String(body.paymentMethod?.maskedCardNumber || '').match(/(\d{4})$/) || [])[1],
    refundedTotal: Number.isFinite(Number(body.refund?.refundedTotal)) ? Number(body.refund.refundedTotal) : undefined,
    amount: Number.isFinite(amount) ? amount : undefined,
    currency: typeof body.currency === 'string' ? body.currency.slice(0, 3) : undefined,
  };
}

const requestFields = (req, rawLimit) => ({
  event: (req.get('x-synrapay-event') || '').slice(0, 80) || undefined,
  signatureTimestamp: (req.get('x-synrapay-timestamp') || '').slice(0, 40) || undefined,
  signatureVersion: (req.get('x-synrapay-signature-version') || '').slice(0, 10) || undefined,
  requestId: req.id,
  ip: req.ip,
  userAgent: (req.get('user-agent') || '').slice(0, 300) || undefined,
  headers: safeHeaders(req),
  rawBody: typeof req.rawBody === 'string' ? req.rawBody.slice(0, rawLimit) : undefined,
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
          provider, deliveryId: req.webhookDeliveryId, verified: true, source: 'WEBHOOK', firstReceivedAt: now, processing: 'RECEIVED',
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
    provider, verified: false, source: 'WEBHOOK', rejectReason: reason, processing: 'REJECTED', outcome: 'rejected before processing', deliveries: 1,
    ...requestFields(req, REJECTED_RAW_LIMIT), ...summarise(body),
  }).catch((err) => console.error('[webhook] could not store rejected delivery:', err.message));
}

/**
 * Records a payment result we learned ourselves (Get Status or the Direct API response) when it changed
 * a payment, so the `webhook` collection has an entry for every completed payment even if no webhook
 * was delivered. One document per payment + result; never throws.
 * @param {{ source: 'GET_STATUS'|'DIRECT_API', event: string, payload: object, payment: object, order?: object, outcome?: string }} r
 */
async function recordResult({ source, event, payload = {}, payment, order, outcome }, provider = 'SYNRAPAY') {
  try {
    const now = new Date();
    const merchantOrderId = payment.merchantOrderId;
    const providerStatus = String(payload.order_status || payload.status || '').slice(0, 40) || undefined;
    const amount = Number(payload.captured_amount ?? payload.amount);
    const deliveryId = crypto.createHash('sha256').update(`${source}|${merchantOrderId}|${providerStatus}|${payment.status}`).digest('hex');
    await WebhookLog.findOneAndUpdate(
      { provider, deliveryId, verified: true },
      {
        $setOnInsert: {
          provider, deliveryId, verified: true, source, event, firstReceivedAt: now,
          payload,
          merchantOrderId,
          orderNumber: order?.orderNumber || String(merchantOrderId).replace(/-P\d+$/i, ''),
          transactionId: String(payload.transactionId || payload.order_id || payment.providerReference || '').slice(0, 200) || undefined,
          paymentLinkId: payment.link?.paymentLinkId,
          providerStatus,
          detailedStatus: payload.detailed_status ? String(payload.detailed_status).slice(0, 40) : undefined,
          code: String(payload.code || payload.response_code || '').slice(0, 20) || undefined,
          message: String(payload.message || payload.response_message || payload.decline_reason || '').slice(0, 300) || undefined,
          amount: Number.isFinite(amount) ? amount : undefined,
          currency: typeof payload.currency === 'string' ? payload.currency.slice(0, 3) : undefined,
          cardBrand: payment.cardBrand,
          cardLast4: payment.cardLast4,
          paymentId: payment._id,
          orderId: order?._id || payment.orderId,
          processing: 'PROCESSED',
          outcome: outcome ? String(outcome).slice(0, 200) : undefined,
          processedAt: now,
        },
        $set: { lastReceivedAt: now },
        $inc: { deliveries: 1 },
      },
      { upsert: true, setDefaultsOnInsert: false },
    );
  } catch (err) {
    console.error('[webhook] could not store payment result:', err.message);
  }
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

module.exports = { recordAccepted, recordRejected, recordOutcome, recordResult };
