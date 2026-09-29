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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
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
app.use('/api', apiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
