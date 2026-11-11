const config = require('../config/env');
const { Payment } = require('../models');
const payments = require('./payment.service');

/**
 * Background Get Status polling.
 *
 * Orders must not depend on the shopper's browser coming back, or on a webhook reaching us (it cannot
 * reach localhost, and deliveries can be late or lost). Every TICK this asks SynraPay for the status of
 * open payment attempts and applies the answer, so `payments` and `orders` are updated server side.
 *
 * Checks back off with the age of the attempt and stop once it can no longer be paid.
 * Applying a result is idempotent, so several API instances may run this at once.
 */
const TICK_MS = 15 * 1000;
const BATCH = 20;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** How long to wait between checks for an attempt of this age. */
function intervalFor(ageMs) {
  if (ageMs < 15 * MINUTE) return 15 * 1000;  // shopper is probably paying right now
  if (ageMs < 2 * HOUR) return 2 * MINUTE;
  if (ageMs < 24 * HOUR) return 15 * MINUTE;
  return HOUR;                                 // long-lived payment links
}

/** When SynraPay can no longer take a payment for this attempt. */
function deadlineOf(p) {
  if (p.method === 'PAY_BY_LINK') return (p.link?.expiresAt ? new Date(p.link.expiresAt).getTime() : p.createdAt.getTime() + 720 * HOUR) + HOUR;
  if (p.method === 'HOSTED_SESSION' && p.session?.expiresAt) return new Date(p.session.expiresAt).getTime() + 6 * HOUR;
  return p.createdAt.getTime() + 24 * HOUR;
}

let timer = null;
let running = false;

async function tick() {
  if (running) return; // previous pass still talking to SynraPay
  running = true;
  try {
    const now = Date.now();
    const open = await Payment.find({
      provider: payments.PROVIDER,
      merchantOrderId: { $type: 'string' },
      $or: [{ status: { $in: ['PENDING', 'AUTHORIZED'] } }, { status: 'FAILED', 'link.status': 'ACTIVE' }],
      createdAt: { $gte: new Date(now - 31 * 24 * HOUR) },
      // Only environments that are configured (attempts without one are `dev`).
      environment: { $in: [...payments.ENVIRONMENTS, ...(payments.ENVIRONMENTS.includes('dev') ? [null] : [])] },
    }).sort({ statusCheckedAt: 1, createdAt: -1 }).limit(200);

    const due = open.filter((p) => now < deadlineOf(p)
      && (!p.statusCheckedAt || now - p.statusCheckedAt.getTime() >= intervalFor(now - p.createdAt.getTime()))).slice(0, BATCH);

    for (const p of due) {
      // eslint-disable-next-line no-await-in-loop
      await payments.reconcilePayment(p); // logs changes and unexpected errors itself; never throws
    }
  } catch (err) {
    console.error('[payments] status polling pass failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer || !config.synrapay.enabled) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref(); // never keeps the process alive on shutdown
  setTimeout(tick, 2000).unref(); // catch up on anything that was paid while the API was down
  console.log(`[payments] Get Status polling started (every ${TICK_MS / 1000}s, environments: ${payments.ENVIRONMENTS.join(', ')})`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
