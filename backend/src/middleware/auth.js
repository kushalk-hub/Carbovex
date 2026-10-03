'use strict';

/**
 * JWT authentication.
 *
 * A token carries identity (userId, companyId, role) and nothing about
 * permissions. Role checks always re-read `app_user`, so deactivating a user
 * or changing their role takes effect on the next request instead of whenever
 * their token happens to expire. See requireRole below.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Company } = require('../models');
const { errors } = require('./errors');
const { asUser } = require('../db/connect');

// Roles that may hold no company, and roles a user may never hold.
const ROLES = ['COMPANY', 'AUDITOR', 'ADMIN'];

function signToken(user) {
  return jwt.sign(
    {
      sub: user.userId,
      // String, not the raw ObjectId. JWT payloads are JSON, and an ObjectId does
      // not survive a JSON round trip intact — serialising it would put a
      // mangled hex string in the claim and every equality check downstream
      // would fail. This is the same reason requireCompany compares strings.
      companyId: user.companyId ? String(user.companyId) : null,
      role: user.role,
    },
    env.jwtSecret,
    {
      expiresIn: env.jwtExpiresIn,
      issuer: 'carbonx',
      // Needed so a single token can be revoked on logout.
      jwtid: crypto.randomUUID(),
    },
  );
}

/**
 * Issue tokens that can be invalidated before they expire.
 *
 * A bare JWT is valid until it expires — there is no server-side kill switch,
 * which means "log out everywhere" is impossible. So every token also carries
 * a jti, and logout drops that jti from a bounded in-memory denylist.
 *
 * This is a deliberate, stated trade-off: it covers the single-server demo and
 * the "log me out" button, and it is the weakest part of the auth story. A
 * multi-instance deployment must move the denylist to Redis.
 */
const revokedTokens = new Map(); // jti -> expiry epoch ms
const REVOKED_SWEEP_MS = 60_000;

function revoke(jti, expiresAtSec) {
  revokedTokens.set(jti, expiresAtSec * 1000);
  if (revokedTokens.size === 1) {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, expMs] of revokedTokens) {
        if (expMs <= now) revokedTokens.delete(key);
      }
      if (revokedTokens.size === 0) clearInterval(timer);
    }, REVOKED_SWEEP_MS);
    timer.unref();
  }
}

function isRevoked(jti) {
  const expMs = revokedTokens.get(jti);
  if (expMs === undefined) return false;
  if (expMs <= Date.now()) {
    revokedTokens.delete(jti);
    return false;
  }
  return true;
}

function decode(token) {
  return jwt.verify(token, env.jwtSecret, { issuer: 'carbonx' });
}

/**
 * Require a valid, non-revoked bearer token and attach req.user.
 * Never trusts claims for authorisation beyond identifying the user.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(errors.unauthorized('Missing Authorization: Bearer <token> header'));
  }

  let claims;
  try {
    claims = decode(token);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token has expired' : 'Invalid token';
    return next(errors.unauthorized(msg));
  }

  if (claims.jti && isRevoked(claims.jti)) {
    return next(errors.unauthorized('Token has been revoked'));
  }

  req.token = token;
  req.tokenClaims = claims;
  req.userId = claims.sub;
  return next();
}

/**
 * Load the current user from the database and cache per request.
 *
 * The role in the JWT can be stale. Every role check goes through this, so a
 * user whose row says is_active = false loses access immediately even while
 * holding a perfectly valid, unexpired token.
 */
async function loadUser(req) {
  if (req.user) return req.user;

  // Populate the company name in the same round trip rather than a second query.
  // The SQL used a LEFT JOIN; a $lookup would work but for one optional field on
  // a request that already loads the user, populating from the buffer is cheaper
  // and keeps the result shape identical to what the routes already expect.
  const user = await User.findById(req.userId)
    .populate({ path: 'companyId', select: 'name' })
    .lean();

  if (!user) throw errors.unauthorized('User no longer exists');
  if (!user.isActive) throw errors.forbidden('This account has been deactivated');

  // Normalise to the camelCase names the routes use. The SQL version returned
  // company_name via the join; here the populate rewrites companyId to the
  // company document, so the name is lifted onto the user to keep req.user
  // shaped the same way it was before the migration.
  const company = user.companyId;
  req.user = {
    userId: user._id,
    companyId: company ? company._id : null,
    companyName: company ? company.name : null,
    verifierId: user.verifierId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
  };
  return req.user;
}

/**
 * Restrict a route to the given roles, e.g. requireRole('ADMIN', 'AUDITOR').
 * Must run after requireAuth.
 */
function requireRole(...allowed) {
  const set = new Set(allowed);
  return async (req, res, next) => {
    try {
      const user = await loadUser(req);
      if (!set.has(user.role)) {
        return next(errors.forbidden(`Requires role ${[...set].join(' or ')}, you are ${user.role}`));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Restrict a route to COMPANY users, and (optionally) to one company.
 *
 * A company user must never reach another company's rows. The check is on the
 * *database* company_id, not the JWT claim, so a forged companyId in a token
 * buys nothing.
 *
 * Two call styles:
 *   requireCompany()                      company-scoped, no target to compare
 *   requireCompany('companyId')           also require the addressed company to
 *                                        be the caller's own
 *   requireCompany({ param: 'id', allow: ['ADMIN', 'AUDITOR'] })
 *                                        the target comes from :id, and roles
 *                                        that hold no company are permitted
 *
 * `allow` exists for endpoints that are genuinely cross-company — an auditor
 * reading any company's compliance position, say. It lists roles explicitly, so
 * widening an endpoint is a visible decision rather than a side effect.
 */
function requireCompany(options = {}) {
  const opts = typeof options === 'string' ? { param: options } : options;
  const paramName = opts.param ?? 'companyId';
  const allowedRoles = new Set(opts.allow ?? []);

  return async (req, res, next) => {
    try {
      const user = await loadUser(req);
      if (user.role !== 'COMPANY') {
        if (!allowedRoles.has(user.role)) {
          return next(errors.forbidden('This endpoint is for company accounts'));
        }
        // A permitted non-company caller still gets the addressed id on the
        // request, so handlers can use req.companyId uniformly.
        const raw = req.params[paramName] ?? req.body?.[paramName];
        req.companyId = raw === undefined ? null : raw;
        return next();
      }
      if (!user.companyId) {
        return next(errors.forbidden('This account is not linked to a company'));
      }

      // If the route addresses a company, it must be the caller's own.
      // Compared as strings: companyId is an ObjectId, and a route param arrives
      // as text. The original SQL compared two integers; Number() coercion here
      // would turn two valid ObjectIds into NaN, and NaN !== NaN would make every
      // cross-company check silently pass.
      const fromPath = req.params[paramName];
      const fromBody = req.body?.[paramName];
      const target = fromPath !== undefined ? fromPath : fromBody;

      if (target !== undefined && target !== null && String(target) !== String(user.companyId)) {
        return next(errors.forbidden('You can only access your own company'));
      }

      req.companyId = user.companyId;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Run fn with the request's user recorded as the acting user.
 *
 * The audit trail needs to know who asked. In PostgreSQL that was a session
 * variable set by the pool before the statement ran; here it is AsyncLocalStorage
 * in db/connect.js, which is per-async-context and therefore safe across
 * overlapping requests.
 *
 * Wrapping a route handler in this is the replacement for the pool's
 * `withTransactionAs(userId, fn)`. It is deliberately not automatic for the whole
 * request: a read that writes nothing does not need the context, and setting it
 * unconditionally would attribute background work triggered by a request to the
 * user who happened to cause it. Only mutations should call this.
 */
function asUserForRequest(req, fn) {
  return asUser(req.userId, fn);
}

/** Hash a sensor key the same way scripts/seed.js stores it: sha256, hex. */
function hashSensorKey(plain) {
  return crypto.createHash('sha256').update(plain, 'utf8').digest('hex');
}

/** Every sha256 hex digest is exactly this long. */
const SHA256_HEX_LENGTH = 64;

/** True only for a 64-character lowercase-or-uppercase hex string. */
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Constant-time compare of two sha256 hex digests.
 *
 * Three rejections before the compare, each for a reason that matters:
 *
 *   length   timingSafeEqual throws on buffers of differing sizes. The length
 *            check is not a timing leak in practice — the lengths are either
 *            both fixed at 64 or the value is not a hash at all — and without it
 *            a malformed stored hash would turn a 401 into a 500.
 *   charset  Buffer.from(x, 'hex') silently truncates at the first invalid pair,
 *            so 'z'.repeat(64) would decode to a 1-byte buffer. Rejecting
 *            non-hex keeps the two operands the same length going in.
 *   type     Anything non-string is rejected rather than coerced.
 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== SHA256_HEX_LENGTH || b.length !== SHA256_HEX_LENGTH) return false;
  if (!HEX_64.test(a) || !HEX_64.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

module.exports = {
  ROLES,
  signToken,
  revoke,
  isRevoked,
  decode,
  requireAuth,
  loadUser,
  requireRole,
  requireCompany,
  asUserForRequest,
  hashSensorKey,
  safeEqualHex,
};
