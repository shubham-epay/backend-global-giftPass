class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
  static badRequest(msg, details) { return new ApiError(400, 'BAD_REQUEST', msg, details); }
  static unauthorized(code = 'UNAUTHORIZED', msg = 'Authentication required') { return new ApiError(401, code, msg); }
  static forbidden(msg = 'You do not have permission to perform this action') { return new ApiError(403, 'FORBIDDEN', msg); }
  static notFound(what = 'Resource') { return new ApiError(404, 'NOT_FOUND', `${what} not found`); }
  static conflict(msg, details) { return new ApiError(409, 'CONFLICT', msg, details); }
}
module.exports = ApiError;
