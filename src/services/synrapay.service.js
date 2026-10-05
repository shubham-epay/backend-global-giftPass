const crypto = require('crypto');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * SynraPay merchant API client. Every call is signed server to server:
 *   x-signature = HMAC_SHA512(`${x-timestamp}.${rawBody}`, api_signature_key), lowercase hex
 * with x-timestamp in milliseconds. A GET has no body and signs `${ts}.`.
 * Never call these from the browser: that would expose the signing key.
 */

// SynraPay codes that are safe and useful to show the shopper as-is.
const PASS_THROUGH = new Set([
  'VALIDATION_ERROR', 'DUPLICATE_ORDER_ID', 'ORDER_ALREADY_PAID', 'ORDER_NOT_PAYABLE', 'PAYMENT_IN_PROGRESS',
  'PAYMENT_LINK_NOT_FOUND', 'PAYMENT_LINK_NOT_EDITABLE', 'ORIGIN_NOT_REGISTERED', 'PAYMENT_BLOCKED', 'EMAIL_NOT_SENT',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_UNSUPPORTED', 'SESSION_EXPIRED',
  // Direct API
  'INVALID_PAYMENT', 'UNSUPPORTED_CURRENCY', 'ORDER_NOT_FOUND', 'GATEWAY_TIMEOUT',
]);

function sign(rawBody) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha512', config.SYNRAPAY_SIGNATURE_KEY).update(`${ts}.${rawBody}`).digest('hex');
  return { ts, sig };
}

/**
 * Signed request. Resolves to the response body; throws ApiError (code SYNRAPAY_* or SynraPay's own).
 * opts.acceptStatuses: extra HTTP statuses whose body is a result, not an error (Direct API: 402 = declined).
 * opts.absolute: `path` already includes /v1 (3-D Secure complete_url), so it is joined to the API host.
 * Request bodies are never logged: Direct API payments carry the card number and CVV.
 */
async function request(method, path, body, opts = {}) {
  if (!config.synrapay.enabled) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now');
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const { ts, sig } = sign(rawBody);

  let res;
  try {
    res = await fetch(`${opts.absolute ? config.synrapay.apiOrigin : config.SYNRAPAY_BASE}${path}`, {
      method,
      headers: {
        ...(rawBody && { 'content-type': 'application/json' }),
        'x-merchant-id': config.SYNRAPAY_MERCHANT_ID,
        'x-timestamp': ts,
        'x-signature': sig,
      },
      body: rawBody || undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    });
  } catch (err) {
    console.error(`[synrapay] ${method} ${path} unreachable:`, err.message);
    throw new ApiError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment provider could not be reached. Please try again.');
  }

  const data = await res.json().catch(() => null);
  if (res.ok) return data || {};
  if (opts.acceptStatuses?.includes(res.status) && data && typeof data.error !== 'object') return data;

  const upstream = (data && typeof data.error === 'object' && data.error) || {};
  const code = upstream.code || 'SYNRAPAY_ERROR';
  console.error(`[synrapay] ${method} ${path} -> ${res.status} ${code}: ${upstream.message || ''}`);
  if (PASS_THROUGH.has(code)) {
    throw new ApiError(res.status >= 500 ? 502 : res.status, code, upstream.message || 'Payment request was refused',
      Array.isArray(upstream.details)
        ? upstream.details.map((d) => ({ path: String(d.field || ''), message: String(d.message || '') }))
        : upstream.field ? [{ path: upstream.field, message: upstream.message }] : undefined);
  }
  // Auth/signature problems are our configuration, not the shopper's fault: don't leak details.
  throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be started. Please try again or choose another method.');
}

const enc = encodeURIComponent;

module.exports = {
  payments: {
    createOrder: (body) => request('POST', '/payments/create-order', body),
    getStatus: (orderId) => request('POST', '/payments/getstatus', { orderId }),
  },
  hostedSessions: {
    create: (body) => request('POST', '/payments/hosted/session', body),
    get: (sessionId) => request('GET', `/payments/hosted/session/${enc(sessionId)}`),
  },
  /**
   * Direct API: our server sends the card. Different product from Hosted Checkout (merchant_order_id,
   * SynraPay order_id). pay/authenticate resolve for approved (200), 3-D Secure required (200,
   * status REQUIRES_ACTION) and declined (402) alike - always branch on `status`.
   */
  direct: {
    createOrder: (body) => request('POST', '/direct/create-order', body),
    pay: (body) => request('POST', '/direct/payment', body, { acceptStatuses: [402], timeoutMs: 45000 }),
    authenticate: (orderId) => request('POST', `/direct/payment/${enc(orderId)}/authenticate`, {}, { acceptStatuses: [402], timeoutMs: 45000 }),
    status: (orderId) => request('GET', `/direct/payment/${enc(orderId)}/status`),
  },
  paymentLinks: {
    create: (body) => request('POST', '/payment-link/create', body),
    createQuick: (body) => request('POST', '/payment-link/create-quick', body),
    details: (body) => request('POST', '/payment-link/details', body),
    remove: (body) => request('POST', '/payment-link/delete', body),
    sendEmail: (body) => request('POST', '/payment-link/send-email', body),
  },
};
