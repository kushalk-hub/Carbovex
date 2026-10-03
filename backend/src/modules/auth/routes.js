'use strict';

/**
 * POST /api/auth/login
 * GET  /api/auth/me
 * POST /api/auth/logout
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { User } = require('../../models');
const { errors } = require('../../middleware/errors');
const { validate, schemas } = require('../../middleware/validate');
const { loginLimiter } = require('../../middleware/rateLimit');
const { signToken, requireAuth, loadUser, revoke, isRevoked } = require('../../middleware/auth');

const router = express.Router();

/**
 * Shape the user for the client. Never include passwordHash.
 *
 * The field names here are the public API contract and are deliberately the
 * legacy ones (`id`, `name`, `company`) rather than the model's (`_id`,
 * `fullName`, `companyId`). The frontend is written against these, and renaming
 * them for internal tidiness would be a breaking API change with no user-visible
 * benefit. The normalisation lives here, once.
 */
function publicUser(u) {
  return {
    id: u.userId ?? u._id,
    email: u.email,
    name: u.fullName ?? u.full_name,
    role: u.role,
    companyId: u.companyId ?? u.company_id ?? null,
    company: u.companyName ?? u.company_name ?? null,
  };
}

/**
 * POST /api/auth/login
 *
 * One generic failure message for both "no such email" and "wrong password" —
 * telling the two apart turns the endpoint into an account enumerator.
 * A dummy bcrypt comparison runs when the user is missing so the response time
 * does not leak it either.
 */
// A real hash, so the "user not found" path costs the same as a real check.
const DUMMY_HASH = bcrypt.hashSync('carbonx-timing-equaliser', 10);

router.post(
  '/login',
  loginLimiter,
  validate(schemas.login),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const user = await User.findOne({ email })
        .populate({ path: 'companyId', select: 'name' })
        .lean();

      if (!user) {
        await bcrypt.compare(password, DUMMY_HASH); // equalise timing
        return next(errors.unauthorized('Invalid email or password'));
      }

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return next(errors.unauthorized('Invalid email or password'));

      if (!user.isActive) {
        return next(errors.forbidden('This account has been deactivated'));
      }

      const company = user.companyId;
      const token = signToken({
        userId: user._id,
        companyId: company ? company._id : null,
        role: user.role,
      });

      res.json({
        token,
        user: publicUser({
          userId: user._id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          companyId: company ? company._id : null,
          companyName: company ? company.name : null,
        }),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/auth/me
 *
 * Re-reads the user row, so a role change or a deactivation is reflected here
 * immediately rather than whenever the old token expires.
 */
router.get(
  '/me',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      res.json({ user: publicUser(user) });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/auth/logout
 *
 * Adds the token's jti to the denylist. Best effort: if the token has no jti
 * or is already invalid, still return 200 — logout must never fail visibly.
 */
router.post(
  '/logout',
  requireAuth,
  async (req, res, next) => {
    try {
      const jti = req.tokenClaims?.jti;
      if (jti && !isRevoked(jti)) {
        revoke(jti, req.tokenClaims.exp ?? Math.floor(Date.now() / 1000) + 3600);
      }
      res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = { router, publicUser };
