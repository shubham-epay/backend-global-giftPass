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
 * The sandbox and dev accounts each sign with their own secret (and api key). On an environment's own
 * webhook URL only that environment's key and secrets are tried; on the shared URL every environment's are.
 * The environment that verified the delivery is set as req.synrapayEnvironment.
 * During secret rotation either secret of an environment is accepted.
 * Responds 401 with no body on failure (nothing for a prober to learn).
 * Rejected deliveries are still written to the `webhook` collection so a bad secret or key is visible.
 */
module.exports = (environmentId) => {
  // The environments this URL accepts deliveries from (that have a webhook secret).
  const WEBHOOK_ENVS = Object.values(config.synrapay.environments)
    .filter((e) => (!environmentId || e.id === environmentId) && e.webhookSecrets.length);
  const name = environmentId ? `SYNRAPAY_${environmentId.toUpperCase()}_WEBHOOK_SECRET` : 'SYNRAPAY_<ENV>_WEBHOOK_SECRET';

  return function verifySynrapayWebhook(req, res, next) {
    if (!WEBHOOK_ENVS.length) {
      console.error(`[webhook] ${name} is not set - rejecting`);
      webhookLog.recordRejected(req, 'webhook secret not configured');
      return res.sendStatus(503);
    }
    // Environments whose api-key header matches (or that don't check one).
    const keyed = WEBHOOK_ENVS.filter((e) => !e.webhookKeyValue || safeEqual(req.get(e.webhookKeyName) || '', e.webhookKeyValue));
    if (!keyed.length) {
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
    const verifiedBy = keyed.find((e) => e.webhookSecrets.some((secret) => safeEqual(
      crypto.createHmac('sha512', secret).update(`${timestamp}.${req.rawBody}`).digest('hex'), signature,
    )));
    if (!verifiedBy) {
      console.warn(`[webhook] ${req.id} rejected: signature mismatch`);
      webhookLog.recordRejected(req, 'signature mismatch');
      return res.sendStatus(401);
    }

    req.synrapayEnvironment = verifiedBy.id;
    req.webhookEvent = req.get('x-synrapay-event') || null;
    // Retries resend the same body, so its hash identifies the delivery for idempotency.
    req.webhookDeliveryId = crypto.createHash('sha256').update(`${req.webhookEvent}|${req.rawBody}`).digest('hex');
    return next();
  };
};
