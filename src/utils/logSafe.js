const { AsyncLocalStorage } = require('async_hooks');

/**
 * Debug logging helpers: which API route a request came in on (so every SynraPay call it makes can say so),
 * and bodies made safe to print.
 */
const routeContext = new AsyncLocalStorage();
/** "POST /api/checkout #1a2b3c4d" for the request being handled, or '' outside one (e.g. the reconciler). */
const currentRoute = () => {
  const c = routeContext.getStore();
  return c ? `${c.method} ${c.path} #${String(c.id).slice(0, 8)}` : '';
};

// Never printed: card data, passwords, secrets and session credentials.
const HIDDEN = new Set([
  'card', 'card_number', 'cardNumber', 'number', 'cvv', 'cvc', 'pan', 'expiry', 'exp_month', 'exp_year',
  'expiry_month', 'expiry_year', 'encrypted_card', 'encryptedCard',
  'password', 'currentPassword', 'newPassword', 'confirmPassword', 'otp',
  'accessToken', 'refreshToken', 'resetToken', 'signatureKey', 'secret',
]);
// Shown shortened: the start identifies them in the logs, the rest stays out.
const SHORTENED = new Set(['client_token', 'clientToken', 'payToken', 'token']);

/** JSON for the logs, with HIDDEN fields replaced and SHORTENED ones cut. */
const forLog = (value) => {
  try {
    return JSON.stringify(value, (k, v) => {
      if (HIDDEN.has(k) && v != null && typeof v !== 'boolean') return '[not logged]';
      if (SHORTENED.has(k) && typeof v === 'string') return `${v.slice(0, 8)}... (${v.length} chars)`;
      return v;
    }, 2);
  } catch {
    return String(value);
  }
};

module.exports = { routeContext, currentRoute, forLog };
