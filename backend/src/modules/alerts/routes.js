'use strict';

/**
 * GET   /api/alerts
 * PATCH /api/alerts/:id/read
 * PATCH /api/alerts/read-all
 * GET   /api/penalties
 *
 * Alerts are raised by the compliance and cap-alert services and pushed to
 * browsers by the realtime bridge. These endpoints only read and mark them, so
 * that marking read on one device does not silently mute another.
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas, q } = require('../../middleware/validate');
const { requireAuth, requireCompany, loadUser } = require('../../middleware/auth');
const { Alert, Penalty, Company, CompliancePeriod } = require('../../models');
const realtime = require('../../realtime');

const router = express.Router();

/** ObjectId, or a 400 that names the field. */
function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/**
 * GET /api/alerts
 *
 * ADMIN and AUDITOR see every alert — they are the ones who need to know a whole
 * sector is breaching. A company sees only its own.
 *
 * The `($1 IS NULL OR company_id = $1)` pattern from the SQL becomes an explicit
 * filter: for a COMPANY the scope is always its own id, and for a privileged
 * caller no filter is applied at all. Building the condition from the role rather
 * than passing a null through is what keeps this a single indexed query.
 */
router.get(
  '/alerts',
  requireAuth,
  validate(schemas.alertQuery, 'query'),
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      const { limit, offset, unreadOnly } = q(req);

      const filter = {};
      if (user.role === 'COMPANY' && user.companyId) filter.companyId = user.companyId;
      if (unreadOnly) filter.isRead = false;

      const [rows, total, unread] = await Promise.all([
        Alert.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(offset)
          .limit(limit)
          .populate({ path: 'companyId', select: 'name' })
          .populate({ path: 'periodId', select: 'year' })
          .lean(),
        // Counted against the scoped set, not the whole collection, or the
        // pager would offer pages a company cannot load.
        Alert.countDocuments(filter),
        Alert.countDocuments({ ...filter, isRead: false }),
      ]);

      const alerts = rows.map((a) => ({
        id: String(a._id),
        companyId: String(a.companyId),
        company: a.companyId?.name ?? null,
        periodId: a.periodId ? String(a.periodId) : null,
        year: a.periodId?.year ?? null,
        type: a.alertType,
        message: a.message,
        isRead: a.isRead,
        createdAt: a.createdAt,
      }));

      res.json({ alerts, total, unread, limit, offset });
    } catch (err) {
      return next(err);
    }
  },
);

/** PATCH /api/alerts/:id/read — mark one alert read. */
router.patch(
  '/alerts/:id/read',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      const alertId = objectId(req.params.id, 'id');

      // Ownership is part of the filter, so a guessed id belonging to another
      // company comes back as 404 rather than 403 — which also avoids confirming
      // that the id exists at all.
      const filter = { _id: alertId };
      if (user.role === 'COMPANY' && user.companyId) filter.companyId = user.companyId;

      const updated = await Alert.findOneAndUpdate(
        filter,
        { $set: { isRead: true } },
        { new: true },
      ).lean();

      if (!updated) return next(errors.notFound(`Alert ${alertId} not found`));

      // Counted against the alert's own company, which is right whether the
      // caller was that company or an admin acting on its behalf.
      const unread = await Alert.countDocuments({ companyId: updated.companyId, isRead: false });

      realtime.emitToCompany(String(updated.companyId), 'alert:read', {
        alertId: String(updated._id),
        unread,
      });

      res.json({ alert: { id: String(updated._id), isRead: updated.isRead }, unread });
    } catch (err) {
      return next(err);
    }
  },
);

/** PATCH /api/alerts/read-all — bulk clear, for a "mark all read" button. */
router.patch(
  '/alerts/read-all',
  requireAuth,
  requireCompany(),
  async (req, res, next) => {
    try {
      const result = await Alert.updateMany(
        { companyId: req.companyId, isRead: false },
        { $set: { isRead: true } },
      );
      realtime.emitToCompany(String(req.companyId), 'alert:read-all', {
        count: result.modifiedCount ?? 0,
      });
      res.json({ updated: result.modifiedCount ?? 0 });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/penalties
 *
 * A company sees its own fines; an admin or auditor sees all of them.
 */
router.get(
  '/penalties',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      const filter = {};
      if (user.role === 'COMPANY' && user.companyId) filter.companyId = user.companyId;

      const rows = await Penalty.find(filter)
        .sort({ issuedAt: -1 })
        .populate({ path: 'companyId', select: 'name' })
        .populate({ path: 'periodId', select: 'year' })
        .lean();

      const penalties = rows.map((p) => ({
        id: String(p._id),
        companyId: String(p.companyId),
        company: p.companyId?.name ?? null,
        periodId: p.periodId ? String(p.periodId) : null,
        year: p.periodId?.year ?? null,
        excessTonnes: p.excessTonnes,
        ratePerTonne: p.ratePerTonne,
        amount: p.fineAmount,
        status: p.status,
        issuedAt: p.issuedAt,
      }));

      // Only settled fines count as paid. An unpaid penalty is a liability, not
      // cash out, and summing them into "totalPaid" would overstate the position.
      const totalPaid = penalties.reduce(
        (sum, p) => (p.status === 'PAID' ? sum + p.amount : sum),
        0,
      );
      const totalOutstanding = penalties.reduce(
        (sum, p) => (p.status === 'UNPAID' ? sum + p.amount : sum),
        0,
      );

      res.json({ penalties, totalPaid, totalOutstanding });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
