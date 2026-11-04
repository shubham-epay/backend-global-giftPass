const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const morgan = require('morgan');

const config = require('./config/env');
const requestId = require('./middlewares/requestId');
const { apiLimiter } = require('./middlewares/rateLimiters');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const ApiError = require('./utils/ApiError');
const routes = require('./routes');
const verifySynrapayWebhook = require('./middlewares/synrapayWebhook');
const pay = require('./controllers/customer/payment.controller');

// SynraPay webhook paths: the shared one, and each environment's own (from SYNRAPAY_<ENV>_WEBHOOK_URL).
const webhookEnvs = Object.values(config.synrapay.environments);
const WEBHOOK_PATHS = new Set([config.synrapay.sharedWebhookPath, ...webhookEnvs.map((e) => e.webhookPath)]);

const app = express();

app.set('trust proxy', config.TRUST_PROXY);
app.disable('x-powered-by');

app.use(requestId);
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(cors({
  origin(origin, cb) {
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new ApiError(403, 'CORS_BLOCKED', 'Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Cart-Token', 'X-Payment-Token'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
}));
app.use(compression());
app.use(express.json({
  limit: '1mb',
  // The payment webhook is signed over the exact bytes received, so keep them - for that route only
  // (other payment routes can carry card details, which must not be kept around).
  verify: (req, _res, buf) => { if (WEBHOOK_PATHS.has(req.originalUrl.split('?')[0])) req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());
app.use(mongoSanitize({ replaceWith: '_' }));
app.use(hpp());

morgan.token('id', (req) => req.id);
app.use(morgan(config.isProd
  ? ':remote-addr :id :method :url :status :res[content-length] - :response-time ms'
  : 'dev', { skip: (req) => req.path === '/api/health' }));

// Admin responses must never be cached by browsers or proxies.
app.use('/api/admin', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// One webhook URL per SynraPay environment, verified only with that environment's api key and secrets.
// Mounted at the app root so the path can be anything SYNRAPAY_<ENV>_WEBHOOK_URL names (e.g. /webhook).
for (const e of webhookEnvs) app.post(e.webhookPath, apiLimiter, verifySynrapayWebhook(e.id), pay.webhook);

app.use('/api', apiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
