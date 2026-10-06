const config = require('../../config/env');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { Payment } = require('../../models');
const payments = require('../../services/payment.service');
const synrapay = require('../../services/synrapay.service');
const webhookLog = require('../../services/webhookLog.service');

const tokenOf = (req) => req.get('x-payment-token') || undefined;

/** GET /api/payments/config - which online methods the storefront can offer. */
const paymentConfig = (_req, res) => {
  const enabled = config.synrapay.enabled;
  res.set('Cache-Control', 'no-store'); // must reflect config changes immediately
  res.json({
    success: true,
    data: {
      enabled,
      environment: config.synrapay.environment,
      methods: enabled ? payments.SYNRAPAY_METHODS : [],
      linkTypes: ['STANDARD', 'QUICK'],
      directCapture: { modes: ['AUTHORIZE', 'CAPTURE'], default: payments.DEFAULT_CAPTURE_MODE },
      linkExpiry: { defaultHours: config.PAYMENT_LINK_EXPIRES_HOURS, minHours: 24, maxHours: 720 },
    },
  });
};

/** GET /api/payments/:orderNumber - order payment status (reconciled with SynraPay) and the latest attempt. */
const paymentStatus = asyncHandler(async (req, res) => {
  const found = await payments.findPayableOrder(req.params.orderNumber, { user: req.user, token: tokenOf(req) });
  const { order, payment } = await payments.reconcile(found);
  res.json({ success: true, data: { order: payments.orderPaymentView(order), payment: payments.paymentView(payment) } });
});

/** POST /api/payments/:orderNumber/start - new attempt with the chosen method (also used to retry or switch). */
const startPayment = asyncHandler(async (req, res) => {
  const order = await payments.findPayableOrder(req.params.orderNumber, { user: req.user, token: tokenOf(req) });
  const payment = await payments.startPayment(order, req.body.method, {
    linkType: req.body.linkType, expiresInHours: req.body.expiresInHours, captureMode: req.body.captureMode, origin: req.get('origin'),
  });
  res.status(201).json({ success: true, data: { order: payments.orderPaymentView(order), payment } });
});

/** POST /api/payments/:orderNumber/send-link - SynraPay emails the active payment link (with a QR code). */
const sendLink = asyncHandler(async (req, res) => {
  const order = await payments.findPayableOrder(req.params.orderNumber, { user: req.user, token: tokenOf(req) });
  const latest = await payments.latestPayment(order);
  if (!latest || latest.method !== 'PAY_BY_LINK' || latest.link?.status !== 'ACTIVE') {
    throw new ApiError(409, 'NO_ACTIVE_LINK', 'There is no active payment link for this order');
  }
  const r = await synrapay.paymentLinks.sendEmail({
    paymentLinkId: latest.link.paymentLinkId, ...(req.body.email && { email: req.body.email }),
  });
  latest.events.push({ type: 'link.email_sent' });
  await latest.save();
  res.json({ success: true, data: { sent: Boolean(r.sent), to: r.to } });
});

/**
 * POST /api/payments/:orderNumber/direct/pay - Direct API: pay with card details from our own form.
 * The card goes straight to SynraPay; it is never stored or logged here. Possible results:
 *   PAID | REQUIRES_ACTION (3-D Secure: render data.action.html in an iframe) | DECLINED | CANCELLED | PENDING
 */
const directPay = asyncHandler(async (req, res) => {
  const order = await payments.findPayableOrder(req.params.orderNumber, { user: req.user, token: tokenOf(req) });
  const result = await payments.payDirect(order, req.body.card);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: result });
});

/** POST /api/payments/:orderNumber/direct/authenticate - finish the payment after the 3-D Secure challenge. */
const directAuthenticate = asyncHandler(async (req, res) => {
  const order = await payments.findPayableOrder(req.params.orderNumber, { user: req.user, token: tokenOf(req) });
  const result = await payments.completeDirect(order);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: result });
});

/**
 * POST /api/payments/synrapay/webhook - signed by SynraPay (see synrapayWebhook middleware).
 * Every delivery is stored in the `webhook` collection, then acknowledged, then applied; the stored
 * document is updated with what happened (PROCESSED / IGNORED / FAILED).
 */
const webhook = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const logId = await webhookLog.recordAccepted(req); // never throws
  // Acknowledge so SynraPay doesn't retry; apply afterwards.
  res.sendStatus(200);
  const body = req.body || {};
  const merchantOrderId = payments.merchantOrderIdOf(body);
  setImmediate(async () => {
    try {
      const result = payments.resultFromWebhook(body, req.webhookEvent);
      const r = await payments.applyResult(merchantOrderId, { ...result, eventId: req.webhookDeliveryId });
      if (r.ignored) console.log(`[webhook] ${merchantOrderId} ${req.webhookEvent || body.status}: ${r.ignored}`);
      else console.log(`[webhook] ${merchantOrderId} -> payment ${r.payment.status}, order ${r.order?.orderStatus}`);
      // Keep the link's own status in step when SynraPay reports it.
      const linkId = body.paymentLinkId || body.paymentLink?.paymentLinkId;
      const linkStatus = body.linkStatus || body.paymentLink?.status;
      if (linkId && linkStatus) await Payment.updateOne({ 'link.paymentLinkId': linkId }, { 'link.status': linkStatus });
      await webhookLog.recordOutcome(logId, {
        processing: r.ignored ? 'IGNORED' : 'PROCESSED',
        outcome: r.ignored || `payment ${r.payment.status}, order ${r.order?.orderStatus || 'n/a'}`,
        payment: r.payment, order: r.order, startedAt,
      });
    } catch (err) {
      console.error(`[webhook] ${merchantOrderId} processing failed:`, err);
      await webhookLog.recordOutcome(logId, { processing: 'FAILED', outcome: 'processing error', error: err, startedAt });
    }
  });
});

module.exports = { paymentConfig, paymentStatus, startPayment, sendLink, directPay, directAuthenticate, webhook };
