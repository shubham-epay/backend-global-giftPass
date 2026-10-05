require('dotenv').config();
const { z } = require('zod');

const bool = (def) =>
  z.enum(['true', 'false', '']).optional().transform((v) => (v === undefined || v === '' ? def : v === 'true'));

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
  // Optional: without a merchant ID and signing key, orders are still placed but can't be paid online.
  SYNRAPAY_BASE: z.string().url().default('https://sandbox-api.synrapay.com/v1'),
  SYNRAPAY_MERCHANT_ID: z.string().optional().transform((v) => v || undefined),
  SYNRAPAY_SIGNATURE_KEY: z.string().optional().transform((v) => v || undefined),
  SYNRAPAY_WEBHOOK_KEY_NAME: z.string().default('x-synrapay-key'),
  SYNRAPAY_WEBHOOK_KEY_VALUE: z.string().optional().transform((v) => v || undefined),
  SYNRAPAY_WEBHOOK_SECRET: z.string().optional().transform((v) => v || undefined),
  SYNRAPAY_WEBHOOK_SECRET_SECONDARY: z.string().optional().transform((v) => v || undefined), // during secret rotation
  SYNRAPAY_HOSTED_SESSION_JS: z.string().url().optional(),
  // Direct API (our own card form). Needs SynraPay to enable it on the account, and PCI DSS attestation
  // in production. Set to false to hide the method.
  SYNRAPAY_DIRECT_API: bool(true),
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

const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
const synraSandbox = env.SYNRAPAY_BASE.includes('sandbox');

const config = Object.freeze({
  ...env,
  isProd,
  COOKIE_SECURE: env.COOKIE_SECURE === undefined ? isProd : env.COOKIE_SECURE,
  corsOrigins,
  STOREFRONT_URL: (env.STOREFRONT_URL || corsOrigins[corsOrigins.length - 1] || 'http://localhost:5174').replace(/\/+$/, ''),
  synrapay: Object.freeze({
    enabled: Boolean(env.SYNRAPAY_MERCHANT_ID && env.SYNRAPAY_SIGNATURE_KEY),
    environment: synraSandbox ? 'sandbox' : 'production',
    directEnabled: env.SYNRAPAY_DIRECT_API,
    // 3-D Secure completion paths (action.complete_url) already start with /v1: join them to the host only.
    apiOrigin: new URL(env.SYNRAPAY_BASE).origin,
    hostedSessionScript: env.SYNRAPAY_HOSTED_SESSION_JS
      || (synraSandbox ? 'https://sandbox.js.synrapay.com/hosted-session.js' : 'https://js.synrapay.com/hosted-session.js'),
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
