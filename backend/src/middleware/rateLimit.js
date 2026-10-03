'use strict';

/**
 * Rate limiters.
 *
 * Two separate budgets, because the two traffic shapes have opposite risk
 * profiles: browsers send hundreds of small GETs a minute, while a leaked
 * sensor key can flood the partitioned emission_reading table — and every
 * accepted row fires two triggers. So POST /api/readings gets its own, much
 * tighter limit than the rest of the API.
 */

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { errors } = require('./errors');

function limiter({ max, windowMs, code, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Behind a proxy, express-rate-limit needs the real client IP. Trusting
    // X-Forwarded-For unconditionally lets a client spoof its way past the
    // limit, so this follows the app's TRUST_PROXY_HOPS setting instead of
    // assuming a proxy is always there.
    ...(env.trustProxyHops > 0 ? { trustProxy: env.trustProxyHops } : {}),
    handler: (req, res, next) => next(errors.tooMany(message)),
    ...(code ? { message: undefined } : {}),
  });
}

/** Broad limiter for the whole API surface. */
const apiLimiter = limiter({
  max: env.rateLimit.max,
  windowMs: env.rateLimit.windowMs,
  message: 'Rate limit exceeded. Try again shortly.',
});

/** Tight limiter for credential stuffing. */
const loginLimiter = limiter({
  max: 10,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts. Wait 15 minutes.',
});

/** Tight limiter for the sensor ingest endpoint. */
const ingestLimiter = limiter({
  max: env.rateLimit.ingestMax,
  windowMs: 60_000,
  message: 'Ingest rate limit exceeded. Slow down or batch more readings per request.',
});

module.exports = { apiLimiter, loginLimiter, ingestLimiter, limiter };
