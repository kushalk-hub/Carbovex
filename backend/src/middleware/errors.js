'use strict';

/**
 * Error type and the Express error handler.
 *
 * Handlers throw; nothing calls res.json({ error }) directly. That keeps the
 * error shape identical across all 30 endpoints and means a bug in one route
 * cannot leak a stack trace or an internal database message to a client.
 */

const env = require('../config/env');

class AppError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    stable machine code, e.g. CX001
   * @param {string} message human message, safe to show a user
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const errors = {
  badRequest: (msg, code = 'CX400') => new AppError(400, code, msg),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'CX401', msg),
  forbidden: (msg = 'You do not have access to this resource') => new AppError(403, 'CX403', msg),
  notFound: (msg = 'Resource not found') => new AppError(404, 'CX404', msg),
  conflict: (msg, code = 'CX409') => new AppError(409, code, msg),
  unprocessable: (msg, code = 'CX422') => new AppError(422, code, msg),
  tooMany: (msg = 'Too many requests') => new AppError(429, 'CX429', msg),
  internal: (msg = 'Internal server error') => new AppError(500, 'CX500', msg),
};

/**
 * MongoDB error shapes that carry a message safe to return, mapped onto our own
 * status codes.
 *
 * The important one is 11000, duplicate key. In PostgreSQL this was SQLSTATE
 * 23505 and it surfaced as a constraint name; here the name arrives in
 * `err.keyPattern` / `err.keyValue`, so the message can name the index that
 * fired. That turns "duplicate value violates a unique key" into something a
 * caller can act on — a duplicate sensor reading is a successful idempotent
 * replay, a duplicate cap is a genuine conflict, and the two should not look
 * identical.
 */
const MONGO_ERROR_MAP = {
  11000: (e) => {
    const field = Object.keys(e.keyPattern || e.keyValue || {})[0];
    return new AppError(
      409,
      'CX409',
      field
        ? `Duplicate value for ${field}: a record with the same ${field} already exists`
        : 'Duplicate value violates a unique index',
    );
  },
  // A cursor or aggregation exceeded its time limit.
  'MaxTimeMSExpired': () => new AppError(503, 'CX503', 'Query took too long and was cancelled'),
  'ExceededTimeLimit': () => new AppError(503, 'CX503', 'Query took too long and was cancelled'),
  'TooManyRequests': () => new AppError(503, 'CX503', 'Database is too busy, retry shortly'),
  'ECONNREFUSED': () => new AppError(503, 'CX503', 'Lost connection to the database'),
};

/** Fallback for our own CXnnn codes, raised by services via errors.*(). */
function fromRaise(err) {
  const match = /^CX(\d{3})$/.exec(err.code || '');
  if (!match) return null;
  const status = { 400: 400, 401: 401, 403: 403, 404: 404, 409: 409, 422: 422, 429: 429 }[
    Number(match[1])
  ] ?? 400;
  return new AppError(status, err.code, err.message);
}

/** 404 for unmatched routes. */
function notFoundHandler(req, res, next) {
  next(new AppError(404, 'CX404', `No route for ${req.method} ${req.originalUrl}`));
}

/** Terminal error handler. Must keep all four parameters to be recognised. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let out = err;

  if (!(out instanceof AppError)) {
    const raised = fromRaise(err);
    if (raised) {
      out = raised;
    } else if (err.name === 'BSONError' || err.name === 'CastError') {
      // A malformed ObjectId is a bad request from the caller, not a server
      // fault. This is the case that would otherwise be a 500 with a stack.
      out = errors.badRequest(`Malformed value: ${err.value ?? err.message}`);
    } else if (MONGO_ERROR_MAP[err.code]) {
      out = MONGO_ERROR_MAP[err.code](err);
    } else if (err.type === 'entity.parse.failed') {
      out = errors.badRequest('Request body is not valid JSON');
    } else if (err.type === 'entity.too.large') {
      out = new AppError(413, 'CX413', 'Request body too large');
    }
  }

  const status = out instanceof AppError ? out.status : 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  const body = {
    error: out.expose ? out.message : 'Internal server error',
    code: out.code || 'CX500',
  };
  // Stack traces are for the log, never for the wire.
  if (!out.expose && !env.isProduction) body.stack = err.stack;
  res.status(status).json(body);
}

module.exports = { AppError, errors, errorHandler, notFoundHandler };
