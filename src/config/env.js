require('dotenv').config();
const { z } = require('zod');

const bool = (def) =>
  z.enum(['true', 'false', '']).optional().transform((v) => (v === undefined || v === '' ? def : v === 'true'));

const optional = z.string().optional().transform((v) => v || undefined);

/** Settings of one SynraPay environment: SYNRAPAY_<NAME>_* (e.g. SYNRAPAY_SANDBOX_MERCHANT_ID). */
const envVars = (name) => ({
  [`SYNRAPAY_${name}_BASE`]: z.string().url().optional(),
  [`SYNRAPAY_${name}_MERCHANT_ID`]: optional,
  [`SYNRAPAY_${name}_SIGNATURE_KEY`]: optional,
  [`SYNRAPAY_${name}_WEBHOOK_KEY_NAME`]: optional,
  [`SYNRAPAY_${name}_WEBHOOK_KEY_VALUE`]: optional,
  [`SYNRAPAY_${name}_WEBHOOK_SECRET`]: optional,
  [`SYNRAPAY_${name}_WEBHOOK_SECRET_SECONDARY`]: optional, // during secret rotation
  // Public URL registered in this environment's dashboard; the API serves its path for this environment only.
  [`SYNRAPAY_${name}_WEBHOOK_URL`]: z.string().url().optional(),
  [`SYNRAPAY_${name}_HOSTED_SESSION_JS`]: z.string().url().optional(),
});

// Older single webhook URL: accepts deliveries from either environment (whichever's secret verifies them).
const SHARED_WEBHOOK_PATH = '/api/payments/synrapay/webhook';

// Per environment: API base, label, and the Hosted Session script (from SynraPay's Hosted Session docs).
// methods: the payment methods the environment may be used for (all when omitted). Hosted Session is
// offered only where the docs give a hosted-session.js script: sandbox and production, not dev.
const SYNRAPAY_ENVIRONMENTS = {
  sandbox: { label: 'Sandbox', base: 'https://sandbox-api.synrapay.com/v1', sdk: 'https://sandbox.js.synrapay.com/hosted-session.js' },
  dev: { label: 'Dev', base: 'https://dev-api.synrapay.com/v1', methods: ['CARD', 'PAY_BY_LINK', 'DIRECT_CARD'] },
  // Live account: real cards are charged. Hosted Checkout (checkout.synrapay.com) and Hosted Session.
  // Hosted Session needs the checkout origin (the live https site) registered with SynraPay.
  production: { label: 'Production', base: 'https://api.synrapay.com/v1', sdk: 'https://js.synrapay.com/hosted-session.js', methods: ['CARD', 'HOSTED_SESSION'], hostedSessionVia: 'direct' },
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1).default('global_gift_pass'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_ISSUER: z.string().default('ggp-api'),
  JWT_AUDIENCE: z.string().default('ggp-admin'),
  JWT_CUSTOMER_AUDIENCE: z.string().default('ggp-customer'),

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(1),
  REFRESH_TOKEN_REMEMBER_TTL_DAYS: z.coerce.number().positive().default(30),
  REFRESH_COOKIE_NAME: z.string().default('ggp_admin_rt'),
  CUSTOMER_REFRESH_COOKIE_NAME: z.string().default('ggp_rt'),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  COOKIE_SECURE: bool(undefined),
  COOKIE_DOMAIN: z.string().optional().transform((v) => v || undefined),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  // ---------- SynraPay (payments) ----------
  // SynraPay environments, each with its own merchant account: `sandbox`, `dev` and `production`. The
  // storefront picks one per payment; an environment without a merchant ID and signing key is not offered.
  // The unprefixed SYNRAPAY_* names are the older single-environment settings and still configure `dev`.
  SYNRAPAY_DEFAULT_ENV: z.enum(['sandbox', 'dev', 'production']).default('dev'),
  ...envVars('SANDBOX'),
  ...envVars('DEV'),
  ...envVars('PRODUCTION'),
  SYNRAPAY_BASE: optional,
  SYNRAPAY_MERCHANT_ID: optional,
  SYNRAPAY_SIGNATURE_KEY: optional,
  SYNRAPAY_WEBHOOK_KEY_NAME: optional,
  SYNRAPAY_WEBHOOK_KEY_VALUE: optional,
  SYNRAPAY_WEBHOOK_SECRET: optional,
  SYNRAPAY_WEBHOOK_SECRET_SECONDARY: optional, // during secret rotation
  SYNRAPAY_HOSTED_SESSION_JS: z.string().url().optional(), // dev only (legacy name)
  // Direct API (our own card form). Needs SynraPay to enable it on the account, and PCI DSS attestation
  // in production. Set to false to hide the method.
  SYNRAPAY_DIRECT_API: bool(true),
  // Direct API: `auto` takes the money in the payment call; `manual` only holds it (authorization)
  // until an admin captures or voids it on the order.
  SYNRAPAY_DIRECT_CAPTURE: z.enum(['auto', 'manual']).default('auto'),
  // Tokenization (saved cards for signed-in customers on the Direct API card form). SynraPay enables it
  // per account and environment; set to false to hide saved cards.
  SYNRAPAY_TOKENIZATION: bool(true),
  PAYMENT_LINK_EXPIRES_HOURS: z.coerce.number().int().min(24).max(720).default(24),
  // Public storefront URL: SynraPay sends shoppers back here after paying (standard links, hosted checkout).
  STOREFRONT_URL: z.string().url().optional(),

  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';

/** One SynraPay environment's settings; `dev` falls back to the unprefixed (legacy) SYNRAPAY_* names. */
function synrapayEnvironment(id) {
  const name = id.toUpperCase();
  const pick = (key) => env[`SYNRAPAY_${name}_${key}`] ?? (id === 'dev' ? env[`SYNRAPAY_${key}`] : undefined);
  const defaults = SYNRAPAY_ENVIRONMENTS[id];
  const base = (pick('BASE') || defaults.base).replace(/\/+$/, '');
  const hostedSessionScriptOverride = pick('HOSTED_SESSION_JS');
  return Object.freeze({
    id,
    label: defaults.label,
    methods: defaults.methods, // undefined: every method
    // How a Hosted Session client token is made: 'direct' = POST /direct/hosted-session (Direct API),
    // otherwise Create Session (POST /payments/hosted/session).
    hostedSessionVia: defaults.hostedSessionVia || 'session',
    enabled: Boolean(pick('MERCHANT_ID') && pick('SIGNATURE_KEY')),
    base,
    merchantId: pick('MERCHANT_ID'),
    signatureKey: pick('SIGNATURE_KEY'),
    // 3-D Secure completion paths (action.complete_url) already start with /v1: join them to the host only.
    apiOrigin: new URL(base).origin,
    webhookKeyName: (pick('WEBHOOK_KEY_NAME') || 'x-synrapay-key').toLowerCase(),
    webhookKeyValue: pick('WEBHOOK_KEY_VALUE'),
    webhookSecrets: [pick('WEBHOOK_SECRET'), pick('WEBHOOK_SECRET_SECONDARY')].filter(Boolean),
    // This environment's own webhook: the URL to register in its dashboard, and the path we serve for it.
    webhookUrl: env[`SYNRAPAY_${name}_WEBHOOK_URL`],
    webhookPath: (env[`SYNRAPAY_${name}_WEBHOOK_URL`] ? new URL(env[`SYNRAPAY_${name}_WEBHOOK_URL`]).pathname : `${SHARED_WEBHOOK_PATH}/${id}`)
      .replace(/\/+$/, '') || '/',
    // Normally the Create Session response names the SDK; this is only the fallback (or a forced override).
    hostedSessionScriptOverride,
    hostedSessionScript: hostedSessionScriptOverride || defaults.sdk,
  });
}
const environments = Object.freeze(Object.fromEntries(Object.keys(SYNRAPAY_ENVIRONMENTS).map((id) => [id, synrapayEnvironment(id)])));
{
  // Each environment's webhook path must be its own: a delivery is verified only with the secrets of its path's environment.
  const paths = [SHARED_WEBHOOK_PATH, ...Object.values(environments).map((e) => e.webhookPath)];
  if (new Set(paths).size !== paths.length) {
    console.error(`[config] SYNRAPAY_<ENV>_WEBHOOK_URL paths must differ from each other and from ${SHARED_WEBHOOK_PATH}: ${paths.join(', ')}`);
    process.exit(1);
  }
}

const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
const config = Object.freeze({
  ...env,
  isProd,
  COOKIE_SECURE: env.COOKIE_SECURE === undefined ? isProd : env.COOKIE_SECURE,
  corsOrigins,
  STOREFRONT_URL: (env.STOREFRONT_URL || corsOrigins[corsOrigins.length - 1] || 'http://localhost:5174').replace(/\/+$/, ''),
  synrapay: Object.freeze({
    environments,
    // The first environment offered: SYNRAPAY_DEFAULT_ENV when it is configured, else any configured one.
    defaultEnvironment: environments[env.SYNRAPAY_DEFAULT_ENV]?.enabled
      ? env.SYNRAPAY_DEFAULT_ENV
      : Object.keys(environments).find((k) => environments[k].enabled) || env.SYNRAPAY_DEFAULT_ENV,
    enabled: Object.values(environments).some((e) => e.enabled),
    sharedWebhookPath: SHARED_WEBHOOK_PATH,
    directEnabled: env.SYNRAPAY_DIRECT_API,
    directManualCapture: env.SYNRAPAY_DIRECT_CAPTURE === 'manual',
    tokenization: env.SYNRAPAY_DIRECT_API && env.SYNRAPAY_TOKENIZATION,
  }),
});

if (config.COOKIE_SAMESITE === 'none' && !config.COOKIE_SECURE) {
  console.error('[config] COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  process.exit(1);
}
if (isProd && /replace-with|changeme/i.test(config.JWT_ACCESS_SECRET)) {
  console.error('[config] Refusing to start in production with a placeholder JWT_ACCESS_SECRET');
  process.exit(1);
}

module.exports = config;
