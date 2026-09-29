const mongoose = require('mongoose');
const { ZodError } = require('zod');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');

function notFound(req, _res, next) {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let error = err;

  if (err instanceof ZodError) {
    error = new ApiError(400, 'VALIDATION_ERROR', 'Some fields are invalid',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  } else if (err instanceof mongoose.Error.ValidationError) {
    error = new ApiError(400, 'VALIDATION_ERROR', 'Some fields are invalid',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })));
  } else if (err instanceof mongoose.Error.CastError) {
    error = new ApiError(400, 'INVALID_ID', `Invalid value for ${err.path}`);
  } else if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field';
    error = new ApiError(409, 'DUPLICATE', `A record with this ${field} already exists`, [{ path: field, message: 'Already in use' }]);
  } else if (err && err.type === 'entity.parse.failed') {
    error = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  } else if (err && err.type === 'entity.too.large') {
    error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else if (!(err instanceof ApiError)) {
    console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, err);
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side');
  }

  if (error.statusCode >= 500 && err instanceof ApiError) console.error(`[error] ${req.id}`, err);

  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      requestId: req.id,
      ...(config.isProd || error.statusCode < 500 ? {} : { stack: err.stack }),
    },
  });
}

module.exports = { notFound, errorHandler };
