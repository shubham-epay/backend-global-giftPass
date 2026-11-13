const crypto = require('crypto');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const { currentRoute, forLog } = require('../utils/logSafe');

/**
 * SynraPay merchant API client. Every call is signed server to server:
 *   x-signature = HMAC_SHA512(`${x-timestamp}.${rawBody}`, api_signature_key), lowercase hex
 * with x-timestamp in milliseconds. A GET has no body and signs `${ts}.`.
 * Never call these from the browser: that would expose the signing key.
 *
 * There is one client per SynraPay environment (`sandbox`, `dev`), each signed with its own merchant
 * account: `synrapay.env('sandbox').payments.createOrder(...)`. A payment is always continued in the
 * environment it was created in.
 */

// SynraPay codes that are safe and useful to show the shopper as-is.
const PASS_THROUGH = new Set([
  'VALIDATION_ERROR', 'DUPLICATE_ORDER_ID', 'ORDER_REJECTED_BY_RISK', 'ORDER_ALREADY_PAID', 'ORDER_NOT_PAYABLE', 'PAYMENT_IN_PROGRESS',
  'PAYMENT_LINK_NOT_FOUND', 'PAYMENT_LINK_NOT_EDITABLE', 'ORIGIN_NOT_REGISTERED', 'PAYMENT_BLOCKED', 'EMAIL_NOT_SENT',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_UNSUPPORTED', 'SESSION_EXPIRED', 'RATE_LIMITED', 'SERVICE_UNDER_MAINTENANCE', 'SERVICE_UNAVAILABLE', 'SESSION_NOT_OPENED', 'DUPLICATE_ORDER_ID',
  // Direct API
  'INVALID_PAYMENT', 'UNSUPPORTED_CURRENCY', 'ORDER_NOT_FOUND', 'GATEWAY_TIMEOUT',
]);

function sign(rawBody, key) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha512', key).update(`${ts}.${rawBody}`).digest('hex');
  return { ts, sig };
}


/** Direct API signature version 2: HMAC_SHA512(`${ts}.${METHOD}.${path}.${rawBody}`), path including /v1. */
function signV2(method, path, rawBody, key) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha512', key).update(`${ts}.${method}.${path}.${rawBody}`).digest('hex');
  return { ts, sig };
}

const unavailable = () => new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now');

/**
 * Signed request. Resolves to the response body; throws ApiError (code SYNRAPAY_* or SynraPay's own).
 * opts.acceptStatuses: extra HTTP statuses whose body is a result, not an error (Direct API: 402 = declined).
 * opts.absolute: `path` already includes /v1 (3-D Secure complete_url), so it is joined to the API host.
 * Every call is logged: the API, what we send and what SynraPay answers. Card data (number, CVV, expiry)
 * is never logged, and client tokens show only their first characters.
 */
async function request(cfg, method, path, body, opts = {}) {
  if (!cfg.enabled) throw unavailable();
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const requestUrl = `${opts.absolute ? cfg.apiOrigin : cfg.base}${path}`;
  const route = new URL(requestUrl);
  const { ts, sig } = opts.signatureVersion === 2
    ? signV2(method, route.pathname, rawBody, cfg.signatureKey)
    : sign(rawBody, cfg.signatureKey);

  let res;
  const via = currentRoute() || 'background job';
  console.log(`[synrapay:${cfg.id}] [for ${via}] -> ${method} ${route.origin}${route.pathname}${opts.signatureVersion === 2 ? ' (signature v2)' : ''}`
    + (body === undefined ? '' : `\n  request: ${forLog(body)}`));
  try {
    res = await fetch(requestUrl, {
      method,
      headers: {
        ...(rawBody && { 'content-type': 'application/json' }),
        'x-merchant-id': cfg.merchantId,
        'x-timestamp': ts,
        'x-signature': sig,
        ...(opts.signatureVersion === 2 && { 'x-signature-version': '2' }),
      },
      body: rawBody || undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    });
  } catch (err) {
    console.error(`[synrapay:${cfg.id}] ${method} ${path} unreachable:`, err.message);
    throw new ApiError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider could not be reached. Please try again.');
  }

  const data = await res.json().catch(() => null);
  console.log(`[synrapay:${cfg.id}] [for ${via}] <- ${res.status} ${method} ${route.pathname}\n  response: ${forLog(data)}`);
  if (res.ok) return data || {};
  if (opts.acceptStatuses?.includes(res.status) && data && typeof data.error !== 'object') return data;

  const upstream = (data && typeof data.error === 'object' && data.error) || {};
  const code = upstream.code || 'SYNRAPAY_ERROR';
  console.error(`[synrapay:${cfg.id}] ${method} ${path} -> ${res.status} ${code}: ${upstream.message || ''}${upstream.request_id ? ` (request ${upstream.request_id})` : ''}`);
  if (PASS_THROUGH.has(code)) {
    throw new ApiError(res.status >= 500 ? 502 : res.status, code, upstream.message || 'Payment request was refused',
      Array.isArray(upstream.details)
        ? upstream.details.map((d) => ({ path: String(d.field || ''), message: String(d.message || '') }))
        : upstream.field ? [{ path: upstream.field, message: upstream.message }] : undefined);
  }
  // Auth/signature problems are our configuration, not the shopper's fault: don't leak details.
  // SynraPay's own code and request reference (no secrets) so the cause is visible and support can find the call.
  const err = new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be started. Please try again or choose another method.', [{
    path: `synrapay:${cfg.id} ${method} ${route.pathname}`,
    message: `${res.status} ${code}: ${upstream.message || ''}${upstream.request_id ? ` (SynraPay request ${upstream.request_id})` : ''}`,
  }]);
  // For callers only (never sent to the client): what SynraPay actually answered.
  err.providerCode = code;
  err.providerStatus = res.status;
  throw err;
}

const enc = encodeURIComponent;

/** The API of one environment. */
function makeClient(cfg) {
  return {
    environment: cfg.id,
    payments: {
      createOrder: (body) => request(cfg, 'POST', '/payments/create-order', body),
      getStatus: (lookup) => request(cfg, 'POST', '/payments/getstatus', typeof lookup === 'string' ? { orderId: lookup } : lookup),
    },
    /**
     * Hosted Session (docs: Hosted Session). Create Session creates the order AND returns the client token
     * in one call: same body as Create Order plus `origin`. Read Session reconciles it.
     */
    hostedSessions: {
      create: (body) => request(cfg, 'POST', '/payments/hosted/session', body),
      get: (sessionId) => request(cfg, 'GET', `/payments/hosted/session/${enc(sessionId)}`),
    },
    /**
     * Direct API: our server sends the card. Different product from Hosted Checkout (merchant_order_id,
     * SynraPay order_id). pay/authenticate resolve for approved (200), 3-D Secure required (200,
     * status REQUIRES_ACTION) and declined (402) alike - always branch on `status`.
     */
    direct: {
      createOrder: (body) => request(cfg, 'POST', '/direct/create-order', body),
      // Hosted Session Client Token: { order (Create Order body) | order_id, origin } -> { client_token, session_id, expires_at, order }.
      hostedSession: (body) => request(cfg, 'POST', '/direct/hosted-session', body, { signatureVersion: 2 }),
      pay: (body) => request(cfg, 'POST', '/direct/payment', body, { acceptStatuses: [402], timeoutMs: 45000 }),
      authenticate: (orderId) => request(cfg, 'POST', `/direct/payment/${enc(orderId)}/authenticate`, {}, { acceptStatuses: [402], timeoutMs: 45000 }),
      status: (orderId) => request(cfg, 'GET', `/direct/payment/${enc(orderId)}/status`),
      // No amount: takes everything the authorization holds.
      capture: (orderId) => request(cfg, 'POST', `/direct/payment/${enc(orderId)}/capture`, {}, { timeoutMs: 45000 }),
      void: (orderId, reason) => request(cfg, 'POST', `/direct/payment/${enc(orderId)}/void`, reason ? { reason } : {}, { timeoutMs: 45000 }),
      // Sends captured money back. Every call is a new refund: after a timeout, read `status` before sending another.
      refund: (orderId, body) => request(cfg, 'POST', `/direct/payment/${enc(orderId)}/refund`, body, { timeoutMs: 45000 }),
    },
    /**
     * Tokenization: cards SynraPay keeps for a customer (customerId is our user id, the customer_id sent
     * on Create Order). Responses carry brand / last4 / expiry only - never a card number or CVV.
     */
    savedCards: {
      save: (customerId, body) => request(cfg, 'POST', `/direct/customers/${enc(customerId)}/payment-methods`, body, { timeoutMs: 45000 }),
      list: (customerId) => request(cfg, 'GET', `/direct/customers/${enc(customerId)}/payment-methods`),
      get: (customerId, id) => request(cfg, 'GET', `/direct/customers/${enc(customerId)}/payment-methods/${enc(id)}`),
      remove: (customerId, id) => request(cfg, 'DELETE', `/direct/customers/${enc(customerId)}/payment-methods/${enc(id)}`),
    },
    paymentLinks: {
      create: (body) => request(cfg, 'POST', '/payment-link/create', body),
      createQuick: (body) => request(cfg, 'POST', '/payment-link/create-quick', body),
      // { paymentLinkId } or { orderId } (our merchantOrderId); paymentLinkId wins if both are sent.
      details: (body) => request(cfg, 'POST', '/payment-link/details', body),
      // Filters and paging are all optional: {} is the most recent links of the last 30 days.
      list: (body = {}) => request(cfg, 'POST', '/payment-link/list', body),
      remove: (body) => request(cfg, 'POST', '/payment-link/delete', body),
      sendEmail: (body) => request(cfg, 'POST', '/payment-link/send-email', body),
    },
  };
}

const clients = Object.fromEntries(Object.entries(config.synrapay.environments).map(([id, cfg]) => [id, makeClient(cfg)]));

/**
 * The client of one environment. Records made before there were two environments have none: they are `dev`.
 * Throws PAYMENTS_UNAVAILABLE for an unknown or unconfigured environment.
 */
function env(id) {
  const client = clients[id || 'dev'];
  if (!client || !config.synrapay.environments[client.environment].enabled) throw unavailable();
  return client;
}

module.exports = { env };
