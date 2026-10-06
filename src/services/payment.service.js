const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const { runInTransaction } = require('../utils/transaction');
const { Order, OrderItem, Payment, Voucher } = require('../models');
const { COUNTRIES } = require('../constants/countries');
const { REVENUE_ORDER_STATUSES } = require('../constants/enums');
const synrapay = require('./synrapay.service');

/**
 * Online payment for storefront orders through SynraPay.
 *
 * Each try at paying an order is one Payment ("attempt") with its own merchantOrderId
 * (order number + attempt number), so a shopper can switch method or retry after a failure.
 * The webhook (or Get Status) is the only thing that marks an order PAID - never the browser.
 */

const PROVIDER = 'SYNRAPAY';
// Direct API attempts that don't say how to capture follow SYNRAPAY_DIRECT_CAPTURE.
const DEFAULT_CAPTURE_MODE = config.synrapay.directManualCapture ? 'AUTHORIZE' : 'CAPTURE';
const SYNRAPAY_METHODS = ['CARD', 'HOSTED_SESSION', 'PAY_BY_LINK', ...(config.synrapay.directEnabled ? ['DIRECT_CARD'] : [])];

// ---------------- pay token (guest access to one order's payment) ----------------
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newPayToken = () => {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
};

/**
 * Loads an order the caller may pay: the signed-in owner, or anyone holding the pay token from checkout.
 * Unknown orders and wrong tokens give the same 404 so order numbers can't be probed.
 */
async function findPayableOrder(orderNumber, { user, token }) {
  const order = await Order.findOne({ orderNumber: String(orderNumber).toUpperCase() }).select('+payTokenHash');
  const owner = order && user && order.userId && String(order.userId) === String(user._id);
  const tokenOk = order && token && order.payTokenHash
    && crypto.timingSafeEqual(Buffer.from(order.payTokenHash), Buffer.from(hashToken(token)));
  if (!order || !(owner || tokenOk)) throw ApiError.notFound('Order');
  return order;
}

// ---------------- SynraPay request bodies ----------------
/** Name in two halves (each 2-120 chars) and the phone split into dial code + national number. */
function synraCustomer(order) {
  const [first = '', ...rest] = (order.customer?.name || '').trim().split(/\s+/);
  const last = rest.join(' ');
  const c = { email: order.customer.email };
  if (first.length >= 2) c.firstName = first.slice(0, 120);
  if (last.length >= 2) c.lastName = last.slice(0, 120);
  const phone = order.customer?.phone && parsePhoneNumberFromString(order.customer.phone);
  if (phone?.isValid()) {
    c.phoneCountryCode = `+${phone.countryCallingCode}`;
    c.phoneNumber = String(phone.nationalNumber);
  }
  return c;
}

/** ISO country code for a stored address (addresses keep the country's name). Undefined when unknown. */
const isoCountry = (name) => COUNTRIES.find((c) => c.name === name || c.code === name)?.code;

/** Optional Create Session address block: only values SynraPay will accept (a malformed field is a 400). */
function synraAddress(a) {
  if (!a) return undefined;
  const out = {};
  const country = isoCountry(a.country);
  if (country) out.country = country;
  if (a.city) out.city = a.city;
  if (a.line1) out.street = [a.line1, a.line2].filter(Boolean).join(', ').slice(0, 200);
  if (a.postalCode) out.postalCode = a.postalCode;
  return Object.keys(out).length ? out : undefined;
}

/** Customer address and line items for Create Session. Shown on the SynraPay dashboard; they don't change what is charged. */
async function sessionDetails(order) {
  const billing = synraAddress(order.billingAddress);
  const shipping = synraAddress(order.shippingAddress);
  const items = (await OrderItem.find({ orderId: order._id }).limit(100).lean()).map((it) => ({
    merchantItemId: String(it.productId || it.giftBoxId || it._id),
    name: String(it.titleSnapshot || 'Item').slice(0, 200),
    count: it.quantity,
    price: it.unitPrice,
  })).filter((it) => Number.isInteger(it.count) && it.count >= 1 && it.price >= 0);
  return {
    ...((billing || shipping) && { address: { ...(billing && { billing }), ...(shipping && { shipping }) } }),
    ...(items.length && { items }),
  };
}

/**
 * Only our own storefronts may be a return target, and SynraPay accepts https return URLs only
 * ("returnUrls.success must use https"), so http://localhost and anything else fall back to STOREFRONT_URL.
 */
const storefrontFor = (origin) => (origin && origin.startsWith('https://') && config.corsOrigins.includes(origin) ? origin : config.STOREFRONT_URL);

/** The page origin a Hosted Session is created for: the storefront the shopper is on when it is one of ours (http://localhost included). */
const sessionOriginFor = (origin) => (origin && config.corsOrigins.includes(origin) ? origin : new URL(config.STOREFRONT_URL).origin);

const returnUrls = (order, origin) => {
  const back = `${storefrontFor(origin)}/pay/${encodeURIComponent(order.orderNumber)}`;
  return { success: `${back}?result=success`, failure: `${back}?result=failure` };
};

const orderBody = (order, merchantOrderId, origin) => ({
  orderId: merchantOrderId,
  amount: order.total,
  currency: order.currency,
  customer: synraCustomer(order),
  description: `Global Gift Pass order ${order.orderNumber}`,
  returnUrls: returnUrls(order, origin),
});

// ---------------- public views ----------------
/** What the storefront needs about an attempt. Never includes card data or secrets beyond the client token. */
function paymentView(p, { withClientToken } = {}) {
  if (!p) return null;
  return {
    _id: p._id,
    method: p.method,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    merchantOrderId: p.merchantOrderId,
    failureReason: p.failureReason || undefined,
    cardBrand: p.cardBrand || undefined,
    cardLast4: p.cardLast4 || undefined,
    ...(p.method === 'HOSTED_SESSION' && {
      session: {
        sessionId: p.session?.sessionId,
        expiresAt: p.session?.expiresAt,
        fallbackCheckoutUrl: p.session?.fallbackCheckoutUrl,
        ...(withClientToken && { clientToken: withClientToken }),
        sdkUrl: config.synrapay.hostedSessionScript,
        environment: config.synrapay.environment,
      },
    }),
    ...(p.method === 'PAY_BY_LINK' && {
      link: { kind: p.link?.kind, url: p.link?.url, status: p.link?.status, expiresAt: p.link?.expiresAt },
    }),
    ...(p.method === 'CARD' && { checkoutUrl: p.checkoutUrl }),
    ...(p.method === 'DIRECT_CARD' && {
      direct: { challenge: Boolean(p.direct?.challenge), captureMode: p.direct?.captureMode || DEFAULT_CAPTURE_MODE, environment: config.synrapay.environment },
    }),
    createdAt: p.createdAt,
  };
}

const orderPaymentView = (order) => ({
  orderNumber: order.orderNumber,
  orderStatus: order.orderStatus,
  paymentStatus: order.paymentStatus,
  paymentMethod: order.paymentMethod,
  total: order.total,
  currency: order.currency,
  paidAt: order.paidAt,
});

// ---------------- start an attempt ----------------
/** PAID, or AUTHORIZED: the amount is held on the shopper's card, waiting to be captured or voided. */
const isSettled = (order) => order.paymentStatus === 'PAID' || order.paymentStatus === 'AUTHORIZED';

function assertPayable(order) {
  if (!isSettled(order) && order.orderStatus === 'PENDING') return;
  const message = order.paymentStatus === 'PAID' ? 'This order is already paid'
    : order.paymentStatus === 'AUTHORIZED' ? 'A payment for this order is already authorized' : 'This order can no longer be paid';
  throw new ApiError(409, 'ORDER_NOT_PAYABLE', message);
}

/** A still-payable link from an earlier attempt is deleted first so the order can't be paid twice. */
async function retirePreviousLinks(order) {
  const open = await Payment.find({ orderId: order._id, provider: PROVIDER, method: 'PAY_BY_LINK', status: { $ne: 'PAID' }, 'link.status': 'ACTIVE' });
  for (const p of open) {
    try {
      await synrapay.paymentLinks.remove({ paymentLinkId: p.link.paymentLinkId, reason: 'Customer chose another payment attempt' });
      p.link.status = 'DELETED';
      p.status = 'FAILED';
      p.failureReason = 'Replaced by a new payment attempt';
      p.events.push({ type: 'link.deleted', status: 'FAILED' });
      await p.save();
    } catch (err) {
      if (err.code === 'ORDER_ALREADY_PAID' || err.code === 'PAYMENT_IN_PROGRESS') {
        throw new ApiError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this order is already being processed. Please wait a moment and refresh.');
      }
      if (err.code !== 'PAYMENT_LINK_NOT_FOUND') throw err;
    }
  }
}

/**
 * Starts a SynraPay payment for a PENDING order.
 * @param {'CARD'|'HOSTED_SESSION'|'PAY_BY_LINK'} method
 * @param {{ linkType?: 'STANDARD'|'QUICK', expiresInHours?: number, captureMode?: 'AUTHORIZE'|'CAPTURE' }} opts
 * @returns the attempt view (HOSTED_SESSION includes the short-lived clientToken)
 */
async function startPayment(order, method, opts = {}) {
  if (!SYNRAPAY_METHODS.includes(method)) throw new ApiError(400, 'UNSUPPORTED_PAYMENT_METHOD', 'This payment method is not available');
  assertPayable(order);

  await retirePreviousLinks(order);
  const attempt = (await Payment.countDocuments({ orderId: order._id, provider: PROVIDER })) + 1;
  const merchantOrderId = `${order.orderNumber}-P${attempt}`;
  // opts.origin: the storefront the shopper is on, so they come back to the same site (and its pay token).
  const body = orderBody(order, merchantOrderId, opts.origin);

  let data;
  let clientToken;
  const fields = {};
  if (method === 'HOSTED_SESSION') {
    // The client token only works on the origin it was created for, and SynraPay needs `origin` sent
    // once more than one is registered (e.g. the live site and http://localhost:5174).
    const origin = sessionOriginFor(opts.origin);
    const { address, items } = await sessionDetails(order);
    // Full Create Session body: the order, plus the optional customer address, line items and origin.
    let session = {
      ...body,
      customer: { ...body.customer, ...(address && { address }) },
      ...(items && { order: { items } }),
      origin,
    };
    let detailed = Boolean(address || items);
    for (;;) {
      try {
        data = await synrapay.hostedSessions.create(session); // eslint-disable-line no-await-in-loop
        break;
      } catch (err) {
        if (err.code === 'ORIGIN_NOT_REGISTERED' && session.origin) {
          // Not registered on the SynraPay account: use the account's own origin, so the order can
          // still be paid there or on fallbackCheckoutUrl.
          console.warn(`[payments] ${merchantOrderId}: origin ${origin} is not registered with SynraPay - register it to use the card form there`);
          session = { ...session, origin: undefined };
        } else if (err.code === 'VALIDATION_ERROR' && detailed) {
          // The address and items are optional extras: never let one of them stop the payment.
          console.warn(`[payments] ${merchantOrderId}: SynraPay refused the optional order details (${JSON.stringify(err.details || err.message)}) - creating the session without them`);
          session = { ...body, origin: session.origin };
          detailed = false;
        } else throw err;
      }
    }
    clientToken = data.clientToken;
    fields.session = { sessionId: data.sessionId, expiresAt: data.expiresAt, fallbackCheckoutUrl: data.fallbackCheckoutUrl };
  } else if (method === 'PAY_BY_LINK') {
    const kind = opts.linkType === 'QUICK' ? 'QUICK' : 'STANDARD';
    const expiresInHours = opts.expiresInHours || config.PAYMENT_LINK_EXPIRES_HOURS;
    data = kind === 'QUICK'
      // Quick links take amount, currency and customer only: no return URLs, no order details.
      ? await synrapay.paymentLinks.createQuick({
        orderId: merchantOrderId, amount: body.amount, currency: body.currency, customer: body.customer, description: body.description, expiresInHours,
      })
      : await synrapay.paymentLinks.create({ ...body, expiresInHours });
    fields.link = { kind, paymentLinkId: data.paymentLinkId, url: data.paymentLinkUrl || data.redirectUrl, status: 'ACTIVE', expiresAt: data.expiresAt };
  } else if (method === 'DIRECT_CARD') {
    // Direct API order: amount + our reference only, no card data yet. The card is sent later by payDirect.
    data = await synrapay.direct.createOrder({
      merchant_order_id: merchantOrderId,
      amount: order.total.toFixed(2), // a string, so nothing reformats it between signing and sending
      currency: order.currency,
      ...(order.userId && { customer_id: String(order.userId) }),
      customer: { name: order.customer?.name, email: order.customer?.email, phone: order.customer?.phone },
    });
    fields.direct = { orderId: data.order_id, captureMode: opts.captureMode || DEFAULT_CAPTURE_MODE };
    data.transactionId = data.order_id;
  } else {
    data = await synrapay.payments.createOrder(body);
    fields.checkoutUrl = data.checkoutUrl;
  }

  const payment = await Payment.create({
    orderId: order._id,
    provider: PROVIDER,
    providerReference: data.transactionId,
    merchantOrderId,
    method,
    amount: order.total,
    currency: order.currency,
    status: 'PENDING',
    events: [{ type: `${method.toLowerCase()}.created`, status: 'PENDING', amount: order.total }],
    ...fields,
  });

  order.paymentMethod = method;
  if (order.paymentStatus === 'FAILED') order.paymentStatus = 'PENDING';
  await order.save();

  return paymentView(payment, { withClientToken: clientToken });
}

// ---------------- apply a result ----------------
// Get Status `order_status` / Direct API `status` (upper case) and webhook `status` (lower case).
const STATUS_FROM_PROVIDER = {
  success: 'PAID', SUCCESS: 'PAID', CAPTURED: 'PAID',
  failed: 'FAILED', FAILED: 'FAILED', DECLINED: 'FAILED', BLOCKED: 'FAILED',
  cancelled: 'FAILED', CANCELLED: 'FAILED', EXPIRED: 'FAILED',
  voided: 'FAILED', VOIDED: 'FAILED',
  authorized: 'AUTHORIZED', AUTHORIZED: 'AUTHORIZED',
  refunded: 'REFUNDED', REFUNDED: 'REFUNDED',
  partially_refunded: 'PARTIALLY_REFUNDED', PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
};
// Used only when a webhook body has no recognisable `status`.
const STATUS_FROM_EVENT = {
  'payment.succeeded': 'PAID', 'payment.failed': 'FAILED', 'payment.voided': 'FAILED', 'payment.authorized': 'AUTHORIZED',
};
// Statuses we deliberately do not act on: we always capture in full, so a partial capture needs a person.
const NEEDS_REVIEW = new Set(['partially_captured', 'PARTIALLY_CAPTURED']);

/**
 * Applies a provider result to the attempt and its order, exactly once per eventId.
 * PAID moves a PENDING order to PAID; FAILED leaves the order PENDING so the shopper can retry;
 * REFUNDED refunds the order and cancels its active vouchers (as an admin refund does).
 */
async function applyResult(merchantOrderId, result) {
  return runInTransaction(async (session) => {
    const payment = await Payment.findOne({ provider: PROVIDER, merchantOrderId }).select('+processedEventIds').session(session);
    if (!payment) return { ignored: 'unknown payment' };
    if (result.eventId && payment.processedEventIds.includes(result.eventId)) return { ignored: 'duplicate', payment };

    const to = result.status;
    const remember = () => { if (result.eventId) payment.processedEventIds.push(result.eventId); };
    const order = await Order.findById(payment.orderId).session(session);

    if (result.review) {
      // e.g. a partial capture: recorded and flagged, never fulfilled automatically.
      payment.reviewRequired = true;
      payment.events.push({ type: result.event || 'needs_review', providerEventId: result.eventId, amount: Number(result.amount) || undefined });
      remember();
      await payment.save({ session });
      console.error(`[payments] ${merchantOrderId}: ${result.review} - needs review`);
      return { ignored: `needs review: ${result.review}`, payment, order };
    }

    const refund = to === 'REFUNDED' || to === 'PARTIALLY_REFUNDED';
    // FAILED is not final: a shopper can retry the card on the same payment link.
    // A paid payment only moves on to a refund; a partial refund can grow or become a full one.
    const locked = payment.status === 'REFUNDED'
      || (payment.status === 'PAID' && !refund)
      || (payment.status === 'PARTIALLY_REFUNDED' && !refund);
    const moreRefunded = to === 'PARTIALLY_REFUNDED' && payment.status === to
      && Number(result.refundedTotal) > (payment.refundedAmount || 0) + 0.005;
    // A refund can only follow money actually taken.
    const refundWithoutPayment = refund && !['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status);
    if (!to || (payment.status === to && !moreRefunded) || locked || refundWithoutPayment) {
      remember();
      await payment.save({ session });
      return { ignored: 'no change', payment, order };
    }

    // Never fulfil a payment that doesn't match what we asked for.
    if ((to === 'PAID' || to === 'AUTHORIZED') && ((result.amount != null && Math.abs(Number(result.amount) - payment.amount) > 0.005)
      || (result.currency && String(result.currency).toUpperCase() !== payment.currency))) {
      payment.reviewRequired = true;
      payment.events.push({ type: 'amount_mismatch', providerEventId: result.eventId, amount: Number(result.amount) || undefined });
      remember();
      await payment.save({ session });
      console.error(`[payments] ${merchantOrderId}: ${to.toLowerCase()} ${result.amount} ${result.currency}, expected ${payment.amount} ${payment.currency} - needs review`);
      return { ignored: 'amount mismatch', payment, order };
    }

    const now = new Date();
    payment.status = to;
    // Only a failure has a failure reason (a paid delivery's message is just "Approved").
    if (to === 'FAILED' && result.reason) payment.failureReason = String(result.reason).slice(0, 500);
    if (to === 'PAID') payment.failureReason = undefined;
    if (result.cardBrand) payment.cardBrand = String(result.cardBrand).slice(0, 20);
    if (/^\d{4}$/.test(result.cardLast4 || '')) payment.cardLast4 = result.cardLast4;
    if (payment.link?.paymentLinkId && to === 'PAID') payment.link.status = 'SUCCESS';
    if (to === 'REFUNDED') payment.refundedAmount = payment.amount;
    if (to === 'PARTIALLY_REFUNDED') {
      // refundedTotal is cumulative (never add deliveries up); clamp to what was paid.
      const total = Number(result.refundedTotal);
      if (Number.isFinite(total) && total > 0) payment.refundedAmount = Math.min(total, payment.amount);
    }
    payment.events.push({ type: result.event || `payment.${to.toLowerCase()}`, providerEventId: result.eventId, status: to, amount: payment.amount, at: now });
    remember();
    await payment.save({ session });

    if (order) {
      const source = result.source || 'WEBHOOK';
      if (to === 'PAID' && order.paymentStatus === 'PAID' && String(order.paymentId) !== String(payment._id)) {
        // Paid twice through two attempts: keep the first, flag this one for a refund.
        payment.reviewRequired = true;
        payment.events.push({ type: 'duplicate_payment', status: 'PAID', amount: payment.amount, at: now });
        await payment.save({ session });
        console.error(`[payments] ${order.orderNumber} paid twice (${merchantOrderId}) - refund the duplicate`);
      } else if (to === 'PAID') {
        order.paymentStatus = 'PAID';
        order.paymentId = payment._id;
        order.paymentMethod = payment.method;
        order.paidAt = order.paidAt || now;
        if (order.orderStatus === 'PENDING') {
          order.statusHistory.push({ from: 'PENDING', to: 'PAID', source, at: now, note: `Paid via SynraPay (${payment.method.replace(/_/g, ' ').toLowerCase()})` });
          order.orderStatus = 'PAID';
        } else {
          console.warn(`[payments] ${order.orderNumber} was paid while ${order.orderStatus}: refund may be needed`);
        }
      } else if (to === 'AUTHORIZED' && isSettled(order) && String(order.paymentId) !== String(payment._id)) {
        // Another attempt already paid for (or holds the amount for) this order: this hold must be released.
        payment.reviewRequired = true;
        payment.events.push({ type: 'duplicate_authorization', status: 'AUTHORIZED', amount: payment.amount, at: now });
        await payment.save({ session });
        console.error(`[payments] ${order.orderNumber} authorized twice (${merchantOrderId}) - void the duplicate`);
      } else if (to === 'AUTHORIZED') {
        // Held, not taken: the order stays PENDING (nothing is fulfilled) until the capture makes it PAID.
        order.paymentStatus = 'AUTHORIZED';
        order.paymentId = payment._id;
        order.paymentMethod = payment.method;
      } else if (to === 'FAILED' && !(isSettled(order) && String(order.paymentId) !== String(payment._id))) {
        // Also a voided authorization. An older attempt failing never undoes another attempt's payment or hold.
        order.paymentStatus = 'FAILED';
      } else if (to === 'PARTIALLY_REFUNDED' && String(order.paymentId) === String(payment._id)) {
        // Part of the money went back: the order stays as it is and its vouchers stay valid.
        order.paymentStatus = 'PARTIALLY_REFUNDED';
        console.warn(`[payments] ${order.orderNumber} partially refunded: ${payment.refundedAmount} of ${payment.amount} ${payment.currency}`);
      } else if (to === 'REFUNDED' && String(order.paymentId) === String(payment._id)) {
        order.paymentStatus = 'REFUNDED';
        order.refundedAt = now;
        if (REVENUE_ORDER_STATUSES.includes(order.orderStatus)) {
          order.statusHistory.push({ from: order.orderStatus, to: 'REFUNDED', source, at: now, note: 'Refunded via SynraPay' });
          order.orderStatus = 'REFUNDED';
          await Voucher.updateMany({ orderId: order._id, status: 'ACTIVE' },
            { status: 'CANCELLED', cancelledAt: now, statusReason: 'Order refunded' }, { session });
        }
      }
      await order.save({ session });
    }
    return { payment, order };
  });
}

/**
 * Maps a webhook body + event header to a result for applyResult (SynraPay webhook envelope:
 * status, detailedStatus, code, reason, message, paymentMethod, and a refund/capture block on operation events).
 * The body's `status` decides; the event name is only a fallback.
 */
function resultFromWebhook(body, event) {
  if (body.paymentLink) return resultFromLinkWebhook(body, event);
  const masked = String(body.paymentMethod?.maskedCardNumber || '');
  const base = {
    event: event || body.event || undefined,
    amount: body.amount,
    currency: body.currency,
    // `message` is plain-language wording that is safe to show the payer; `reason` is the code's name.
    reason: body.message || body.reason || body.detailedStatus || body.error_message,
    cardBrand: body.paymentMethod?.brand || body.card?.brand || body.cardBrand,
    cardLast4: (masked.match(/(\d{4})$/) || [])[1] || body.card?.last4 || body.cardLast4,
    source: 'WEBHOOK',
  };
  if (NEEDS_REVIEW.has(body.status)) {
    return { ...base, review: `partial capture (${body.capture?.capturedTotal ?? '?'} of ${body.amount} ${body.currency || ''} captured)` };
  }
  const status = STATUS_FROM_PROVIDER[body.status] || STATUS_FROM_PROVIDER[body.detailedStatus] || STATUS_FROM_EVENT[event];
  if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
    // On refund events `amount` is still the order amount; the refund block carries the cumulative total.
    return { ...base, status, amount: undefined, refundedTotal: body.refund?.refundedTotal, reason: body.refund?.reason };
  }
  // A void's `message` is "Approved" (the operation succeeded), which is not why the payment ended.
  if (body.status === 'voided') return { ...base, status, reason: body.void?.reason || 'Authorization voided' };
  return { ...base, status };
}

/** Our attempt id in a webhook body: orderId (Hosted), merchant_order_id (Direct API) or the payment link's referenceId. */
const merchantOrderIdOf = (body = {}) => String(body.orderId || body.merchant_order_id || body.paymentLink?.referenceId || body.order?.orderId || '');

/**
 * Payment link deliveries (payment.authorized, payment.captured, order.paid, payment_link.paid) use their
 * own envelope: { status, paymentLink, order, payment }. Their `status` is "success" on every one of them,
 * so the order block decides: it is paid only when order.status says so.
 */
function resultFromLinkWebhook(body, event) {
  const base = {
    event: event || body.event || undefined,
    currency: body.order?.currency || body.paymentLink.currency,
    cardBrand: body.payment?.card?.brand,
    cardLast4: body.payment?.card?.last4,
    source: 'WEBHOOK',
  };
  if (String(body.order?.status).toLowerCase() === 'paid') return { ...base, status: 'PAID', amount: body.order.amountPaid ?? body.paymentLink.amountPaid };
  const status = STATUS_FROM_PROVIDER[body.status];
  return { ...base, status: status === 'PAID' ? undefined : status, reason: body.payment?.codes?.message || body.message };
}

// ---------------- reconcile (Get Status) ----------------
/** An attempt whose outcome is still open: not yet decided, held but not captured, or failed on a link the shopper can still pay. */
const isOpen = (p) => p.status === 'PENDING' || p.status === 'AUTHORIZED' || (p.status === 'FAILED' && p.link?.status === 'ACTIVE');

/**
 * Asks SynraPay (Get Status) what happened to one attempt and applies it to the payment and its order.
 * This is what moves an order to PAID when no webhook reaches us. Safe to call repeatedly.
 * @returns {{ payment, order?, providerStatus?, changed: boolean, error?: Error }}
 */
async function reconcilePayment(payment) {
  if (!payment || !isOpen(payment)) return { payment, changed: false };
  let providerStatus;
  try {
    let data;
    if (payment.method === 'DIRECT_CARD') {
      if (!payment.direct?.orderId) return { payment, changed: false };
      const st = await synrapay.direct.status(payment.direct.orderId);
      // A hold has nothing captured yet: compare what is held, not what was taken.
      const amount = st.status === 'AUTHORIZED' ? st.authorized_amount ?? st.amount : st.captured_amount ?? st.amount;
      data = { order_status: st.status, amount, currency: st.currency, reason: st.response_message };
    } else {
      ({ data } = await synrapay.payments.getStatus(payment.merchantOrderId));
    }
    providerStatus = data?.order_status;
    await Payment.updateOne({ _id: payment._id }, { statusCheckedAt: new Date(), $inc: { statusChecks: 1 }, ...(providerStatus && { providerStatus: String(providerStatus).slice(0, 40) }) });

    const to = providerStatus && STATUS_FROM_PROVIDER[providerStatus];
    if ((to === 'PAID' || to === 'FAILED' || to === 'AUTHORIZED') && to !== payment.status) {
      const r = await applyResult(payment.merchantOrderId, {
        status: to, amount: data.amount, currency: data.currency, source: 'SYSTEM',
        event: `getstatus.${String(providerStatus).toLowerCase()}`,
        reason: to === 'FAILED' ? (data.decline_reason || data.message || data.reason) : undefined,
      });
      const changed = !r.ignored;
      if (changed) console.log(`[payments] ${payment.merchantOrderId}: Get Status ${providerStatus} -> payment ${r.payment.status}, order ${r.order?.orderStatus}`);
      else if (r.ignored !== 'no change') console.warn(`[payments] ${payment.merchantOrderId}: Get Status ${providerStatus} not applied (${r.ignored})`);
      return { payment: r.payment || payment, order: r.order, providerStatus, changed };
    }
    return { payment, providerStatus, changed: false };
  } catch (err) {
    await Payment.updateOne({ _id: payment._id }, { statusCheckedAt: new Date(), $inc: { statusChecks: 1 } }).catch(() => {});
    // "Not found" is normal before the shopper opens the payment page; anything else is worth seeing.
    const expected = err.statusCode === 404 || err.code === 'ORDER_NOT_FOUND';
    if (!expected) console.warn(`[payments] Get Status failed for ${payment.merchantOrderId}: ${err.code || ''} ${err.message}`);
    return { payment, providerStatus, changed: false, error: err };
  }
}

/**
 * Reconciles an order's open attempts (newest first) with SynraPay. Used when the shopper returns
 * or polls, so the page is right even if the webhook is late.
 */
async function reconcile(order) {
  const attempts = await Payment.find({ orderId: order._id, provider: PROVIDER }).sort({ createdAt: -1 }).limit(5);
  let current = order;
  for (const p of attempts.filter(isOpen)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await reconcilePayment(p);
    if (r.order) current = r.order;
    if (current.paymentStatus === 'PAID') break;
  }
  const latest = attempts.length ? await Payment.findById(attempts[0]._id) : null;
  return { order: current, payment: latest };
}

// ---------------- Direct API (our own card form) ----------------
const DIRECT_DECLINE_COPY = {
  PAYMENT_DECLINED: 'Your card was declined. Please try another card or contact your bank.',
  PAYMENT_FAILED: 'The payment was not completed. You have not been charged.',
  GATEWAY_TIMEOUT: 'The payment timed out and was not completed. Please try again.',
  INVALID_PAYMENT: 'These card details were not accepted. Please check them and try again.',
};

/** What the storefront gets once the card went through: PAID, or AUTHORIZED when capture is manual. */
const settledView = (order) => ({ status: order.paymentStatus, order: orderPaymentView(order) });

/**
 * Turns a Direct API payment / authenticate response into what the storefront needs, applying
 * the outcome to the order. Approved here is authoritative: it is the response to our signed call.
 */
async function settleDirect(order, payment, res, card) {
  if (res.status === 'REQUIRES_ACTION' && res.action?.type === '3ds_challenge') {
    await Payment.updateOne({ _id: payment._id }, { 'direct.challenge': true });
    // The issuer's challenge page: rendered in an iframe by the storefront. Contains no card data.
    return { status: 'REQUIRES_ACTION', action: { type: '3ds_challenge', html: res.action.html } };
  }
  const to = STATUS_FROM_PROVIDER[res.status];
  if (to === 'PAID') {
    const r = await applyResult(payment.merchantOrderId, {
      status: 'PAID', amount: res.captured_amount ?? res.amount, currency: res.currency, source: 'SYSTEM',
      event: 'direct.captured', cardLast4: card?.last4,
    });
    await Payment.updateOne({ _id: payment._id }, { 'direct.challenge': false });
    return { status: 'PAID', order: orderPaymentView(r.order || order) };
  }
  if (to === 'AUTHORIZED') {
    // capture: false - the amount is held on the card; an admin captures or voids it later.
    const r = await applyResult(payment.merchantOrderId, {
      status: 'AUTHORIZED', amount: res.authorized_amount ?? res.amount, currency: res.currency, source: 'SYSTEM',
      event: 'direct.authorized', cardLast4: card?.last4,
    });
    await Payment.updateOne({ _id: payment._id }, { 'direct.challenge': false });
    return settledView(r.order || order);
  }
  if (to === 'FAILED') {
    const cancelled = res.status === 'CANCELLED';
    await applyResult(payment.merchantOrderId, {
      status: 'FAILED', source: 'SYSTEM', event: cancelled ? 'direct.cancelled' : 'direct.declined',
      reason: res.error_message || res.response_message, cardLast4: card?.last4,
    });
    await Payment.updateOne({ _id: payment._id }, { 'direct.challenge': false });
    return {
      status: cancelled ? 'CANCELLED' : 'DECLINED',
      code: res.error_code || 'PAYMENT_DECLINED',
      message: cancelled
        ? 'Card verification was cancelled. You have not been charged - you can try again.'
        : DIRECT_DECLINE_COPY[res.error_code] || DIRECT_DECLINE_COPY.PAYMENT_DECLINED,
    };
  }
  // Anything unexpected: let Get Status decide.
  const rec = await reconcile(order);
  return isSettled(rec.order) ? settledView(rec.order) : { status: 'PENDING', order: orderPaymentView(rec.order) };
}

/** After a timeout / 5xx the outcome is unknown: never resend, ask Get Status what happened. */
async function directOutcomeUnknown(order, err) {
  if (!(err.statusCode >= 500)) throw err;
  const rec = await reconcile(order);
  if (isSettled(rec.order)) return settledView(rec.order);
  return { status: 'PENDING', message: 'We could not confirm the payment yet. Please wait a moment and check again before retrying.' };
}

/**
 * Pays an order with card details through the Direct API, or only authorizes it when the attempt's
 * captureMode is AUTHORIZE (chosen at checkout; SYNRAPAY_DIRECT_CAPTURE is the default).
 * The card ({ number, expiry_month, expiry_year, cvv, name }) is passed straight to SynraPay and is
 * never stored or logged - only the last 4 digits are kept on the Payment.
 * A Direct order can be paid only once, so a retry after a decline gets a fresh attempt automatically.
 */
async function payDirect(order, card) {
  if (!config.synrapay.directEnabled) throw new ApiError(400, 'UNSUPPORTED_PAYMENT_METHOD', 'This payment method is not available');
  assertPayable(order);
  let payment = await latestPayment(order);
  const reusable = payment && payment.method === 'DIRECT_CARD' && payment.status === 'PENDING' && !payment.direct?.attempted && payment.direct?.orderId;
  if (!reusable) {
    if (payment?.method === 'DIRECT_CARD' && payment.status === 'PENDING' && payment.direct?.attempted) {
      // A card was already submitted on this attempt (e.g. 3-D Secure left open): make sure it didn't go through.
      const rec = await reconcile(order);
      if (isSettled(rec.order)) return settledView(rec.order);
    }
    // A retry keeps the way the shopper chose to pay (authorize only, or capture at once).
    await startPayment(order, 'DIRECT_CARD', { captureMode: payment?.method === 'DIRECT_CARD' ? payment.direct?.captureMode : undefined });
    payment = await latestPayment(order);
  }
  // Mark before calling: if we crash mid-call this order is never charged a second time.
  await Payment.updateOne({ _id: payment._id }, { 'direct.attempted': true, $push: { events: { type: 'direct.payment_submitted', status: 'PENDING' } } });

  const meta = { last4: card.number.slice(-4) };
  let res;
  try {
    res = await synrapay.direct.pay({
      order_id: payment.direct.orderId,
      card: { number: card.number, expiry_month: card.expiry_month, expiry_year: card.expiry_year, cvv: card.cvv, ...(card.name && { name: card.name }) },
      // false: authorize only - the amount is held until an admin captures or voids it.
      capture: (payment.direct.captureMode || DEFAULT_CAPTURE_MODE) !== 'AUTHORIZE',
      // No return_url: SynraPay's default return page posts { type: 'synrapay-3ds-return' } to our page.
    });
  } catch (err) {
    return directOutcomeUnknown(order, err);
  }
  return settleDirect(order, payment, res, meta);
}

/** Finishes a Direct API payment after the shopper completed (or abandoned) the 3-D Secure challenge. */
async function completeDirect(order) {
  const payment = await latestPayment(order);
  if (!payment || payment.method !== 'DIRECT_CARD' || !payment.direct?.orderId || !payment.direct.attempted) {
    throw new ApiError(409, 'NO_PENDING_CHALLENGE', 'There is no card verification to complete for this order');
  }
  if (isSettled(order)) return settledView(order);
  let res;
  try {
    res = await synrapay.direct.authenticate(payment.direct.orderId);
  } catch (err) {
    if (err.statusCode === 409 || err.statusCode === 400) {
      // Called too early, or the order is already final: Get Status has the truth.
      const rec = await reconcile(order);
      if (isSettled(rec.order)) return settledView(rec.order);
      if (rec.payment?.status === 'FAILED') return { status: 'DECLINED', code: 'PAYMENT_FAILED', message: DIRECT_DECLINE_COPY.PAYMENT_FAILED };
      return { status: 'REQUIRES_ACTION', message: 'Card verification is not finished yet. Complete it in the window above.' };
    }
    return directOutcomeUnknown(order, err);
  }
  return settleDirect(order, payment, res);
}

/**
 * Captures (takes) or voids (releases) the amount a Direct API authorization holds. Admin only.
 * Capture is always for the full amount and is what makes the order PAID; a void leaves the order
 * PENDING with a failed payment, like a decline, so it can be paid again or cancelled.
 * @param {'capture'|'void'} operation
 * @returns {{ payment, order }}
 */
async function settleAuthorization(paymentId, operation, { reason } = {}) {
  const payment = await Payment.findOne({ _id: paymentId, provider: PROVIDER });
  if (!payment) throw ApiError.notFound('Payment');
  if (payment.method !== 'DIRECT_CARD' || !payment.direct?.orderId || payment.status !== 'AUTHORIZED') {
    throw new ApiError(409, 'PAYMENT_NOT_AUTHORIZED', 'Only an authorized Direct API payment can be captured or voided');
  }
  const capture = operation === 'capture';
  const to = capture ? 'PAID' : 'FAILED';
  let res;
  try {
    res = capture ? await synrapay.direct.capture(payment.direct.orderId) : await synrapay.direct.void(payment.direct.orderId, reason);
  } catch (err) {
    // Refused (already captured, already voided, nothing held) or outcome unknown (timeout / 5xx):
    // never resend - Get Status says what the payment is now.
    const rec = await reconcilePayment(payment);
    if (rec.payment.status === to) return { payment: rec.payment, order: rec.order || await Order.findById(payment.orderId) };
    if (err.statusCode >= 500) {
      throw new ApiError(502, 'PAYMENT_OUTCOME_UNKNOWN', `We could not confirm the ${operation} with SynraPay. Reload the order in a moment before trying again.`);
    }
    throw err;
  }
  const r = await applyResult(payment.merchantOrderId, capture
    ? { status: 'PAID', amount: res.captured_amount ?? res.amount, currency: res.currency, source: 'ADMIN', event: 'direct.captured' }
    : { status: 'FAILED', source: 'ADMIN', event: 'direct.voided', reason: `Authorization voided${reason ? `: ${reason}` : ''}` });
  if (r.payment?.status !== to) {
    // e.g. a partial capture or an amount mismatch: recorded and flagged, never fulfilled automatically.
    throw new ApiError(409, 'PAYMENT_NEEDS_REVIEW', `SynraPay accepted the ${operation}, but it could not be applied to the order (${r.ignored || 'unknown'}). Check the payment in SynraPay.`);
  }
  return { payment: r.payment, order: r.order };
}

async function latestPayment(order) {
  return Payment.findOne({ orderId: order._id, provider: PROVIDER }).sort({ createdAt: -1 });
}

module.exports = {
  PROVIDER, DEFAULT_CAPTURE_MODE, SYNRAPAY_METHODS, newPayToken, findPayableOrder, startPayment, applyResult, resultFromWebhook, merchantOrderIdOf,
  reconcile, reconcilePayment, isOpen, latestPayment, paymentView, orderPaymentView, payDirect, completeDirect, settleAuthorization,
};
