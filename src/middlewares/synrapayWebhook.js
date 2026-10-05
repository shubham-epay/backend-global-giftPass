const crypto = require('crypto');
const config = require('../config/env');
const webhookLog = require('../services/webhookLog.service');

const MAX_SKEW_SECONDS = 300;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Verifies a SynraPay webhook (signature v2):
 *   x-synrapay-signature = HMAC_SHA512(`${x-synrapay-timestamp}.${rawBody}`, webhookSecret), lowercase hex
 * plus the configured API-key header and a 5-minute freshness check on the signed timestamp.
 * During secret rotation either secret is accepted.
 * Responds 401 with no body on failure (nothing for a prober to learn).
 * Rejected deliveries are still written to the `webhook` collection so a bad secret or key is visible.
 */
module.exports = function verifySynrapayWebhook(req, res, next) {
  const secrets = [config.SYNRAPAY_WEBHOOK_SECRET, config.SYNRAPAY_WEBHOOK_SECRET_SECONDARY].filter(Boolean);
  if (!secrets.length) {
    console.error('[webhook] SYNRAPAY_WEBHOOK_SECRET is not set - rejecting');
    webhookLog.recordRejected(req, 'webhook secret not configured');
    return res.sendStatus(503);
  }
  if (config.SYNRAPAY_WEBHOOK_KEY_VALUE
    && !safeEqual(req.get(config.SYNRAPAY_WEBHOOK_KEY_NAME) || '', config.SYNRAPAY_WEBHOOK_KEY_VALUE)) {
    console.warn(`[webhook] ${req.id} rejected: api-key header mismatch`);
    webhookLog.recordRejected(req, 'api-key header mismatch');
    return res.sendStatus(401);
  }

  const timestamp = req.get('x-synrapay-timestamp');
  const signature = String(req.get('x-synrapay-signature') || '').toLowerCase();
  if (!timestamp || !signature || typeof req.rawBody !== 'string') {
    console.warn(`[webhook] ${req.id} rejected: missing signature, timestamp or body`);
    webhookLog.recordRejected(req, 'missing signature, timestamp or body');
    return res.sendStatus(401);
  }
  // Freshness: a captured delivery keeps a valid signature forever, so the signed timestamp is what
  // stops it being replayed later. SynraPay sends Unix seconds (milliseconds are tolerated).
  const sent = Number(timestamp);
  const sentSeconds = sent > 1e12 ? sent / 1000 : sent;
  if (!Number.isFinite(sentSeconds) || Math.abs(Date.now() / 1000 - sentSeconds) > MAX_SKEW_SECONDS) {
    console.warn(`[webhook] ${req.id} rejected: timestamp outside the ${MAX_SKEW_SECONDS}s window`);
    webhookLog.recordRejected(req, 'stale or invalid timestamp');
    return res.sendStatus(401);
  }
  const valid = secrets.some((secret) => safeEqual(
    crypto.createHmac('sha512', secret).update(`${timestamp}.${req.rawBody}`).digest('hex'), signature,
  ));
  if (!valid) {
    console.warn(`[webhook] ${req.id} rejected: signature mismatch`);
    webhookLog.recordRejected(req, 'signature mismatch');
    return res.sendStatus(401);
  }

  req.webhookEvent = req.get('x-synrapay-event') || null;
  // Retries resend the same body, so its hash identifies the delivery for idempotency.
  req.webhookDeliveryId = crypto.createHash('sha256').update(`${req.webhookEvent}|${req.rawBody}`).digest('hex');
  return next();
};
