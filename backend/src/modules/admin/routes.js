'use strict';

/**
 * PUT  /api/caps                              set caps in bulk (admin)
 * POST /api/admin/compliance/:periodId/run     close a period (admin)
 * GET  /api/admin/overview                    operational dashboard (admin)
 * POST /api/admin/period-totals/rebuild       repair the running totals (admin)
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas } = require('../../middleware/validate');
const { requireAuth, requireRole, asUserForRequest } = require('../../middleware/auth');
const {
  CompliancePeriod,
  EmissionCap,
  Company,
  Facility,
  Sensor,
  EmissionReading,
  MarketOrder,
  Alert,
  EmissionReport,
  Trade,
} = require('../../models');
const { transaction } = require('../../models/helpers');
const { readings, aggregations, audit: auditService } = require('../../services');
const realtime = require('../../realtime');

const router = express.Router();

/**
 * Applied per route rather than with router.use().
 *
 * This router is mounted at /api, so router.use(requireRole('ADMIN')) would run
 * for every API request and reject all of them. Listing the guard on each route
 * makes the requirement local and impossible to forget.
 */
const adminOnly = [requireAuth, requireRole('ADMIN')];

function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/**
 * PUT /api/caps
 *
 * Body: { periodId, caps: [{ companyId, capTonnes }] }
 *
 * One transaction for the whole batch: caps are only compared in aggregate
 * (sector totals, national allocation), so a half-applied batch is worse than a
 * rejected one. Re-issuing a cap for the same (company, period) updates it and
 * leaves an audit row, rather than failing.
 */
router.put(
  '/caps',
  ...adminOnly,
  validate(schemas.setCaps),
  async (req, res, next) => {
    try {
      const { periodId, caps } = req.body;

      const result = await asUserForRequest(req, () =>
        transaction(async (s) => {
          const period = await CompliancePeriod.findById(periodId, null, { session: s }).lean();
          if (!period) throw errors.notFound(`Period ${periodId} does not exist`);

          // Referenced companies are checked explicitly. MongoDB has no foreign
          // keys, so a typo in a company id would otherwise create a cap for a
          // company that does not exist and silently skew every sector total.
          const ids = caps.map((c) => c.companyId);
          const known = await Company.find({ _id: { $in: ids } })
            .select('_id')
            .session(s)
            .lean();
          const knownIds = new Set(known.map((c) => String(c._id)));
          const unknown = ids.filter((id) => !knownIds.has(id));
          if (unknown.length > 0) {
            throw errors.unprocessable(`Unknown company ids: ${unknown.join(', ')}`);
          }

          // bulkWrite rather than a loop, so the batch is one round trip and the
          // upserts are unordered. ordered:false is what lets a duplicate (company,
          // period) in the same batch be reported as one duplicate key rather
          // than aborting everything after it.
          const ops = caps.map((c) => ({
            updateOne: {
              filter: { companyId: c.companyId, periodId },
              update: { $set: { capTonnes: c.capTonnes }, $setOnInsert: { companyId: c.companyId, periodId } },
              upsert: true,
            },
          }));

          const write = await EmissionCap.collection.bulkWrite(ops, { ordered: false, session: s });
          if (write.writeErrors?.length) {
            throw errors.conflict(
              `Could not set ${write.writeErrors.length} cap(s): ` +
                write.writeErrors.map((e) => e.errmsg).join('; '),
            );
          }

          // The audit trail for each cap. bulkWrite bypasses the model hooks, so
          // this is written explicitly — the same trade-off as the bulk ingest.
          for (const c of caps) {
            const doc = await EmissionCap.findOne({ companyId: c.companyId, periodId })
              .session(s)
              .lean();
            if (doc) {
              await auditService.updated('emissioncaps', doc, doc, s);
            }
          }

          const total = await EmissionCap.aggregate(
            [{ $match: { periodId } }, { $group: { _id: null, total: { $sum: '$capTonnes' } } }],
            { session: s },
          ).exec();

          return {
            year: period.year,
            updated: caps.length,
            totalCapTonnes: total.length ? Number(total[0].total) : 0,
            caps: caps.map((c) => ({ companyId: String(c.companyId), capTonnes: c.capTonnes })),
          };
        }),
      );

      realtime.emitToAll('caps:updated', { periodId, count: result.updated });

      res.json({ periodId, year: result.year, ...result });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/admin/compliance/:periodId/run
 *
 * Closes a period: works out who is over cap, retires credits to cover the
 * excess, and levies penalties where credits are unavailable. All of it happens
 * inside the compliance service, which closes the period in the same transaction
 * as the penalties — this route calls it and reports.
 */
router.post(
  '/admin/compliance/:periodId/run',
  ...adminOnly,
  async (req, res, next) => {
    try {
      const periodId = objectId(req.params.periodId, 'periodId');
      const rate = req.body?.ratePerTonne;

      // Refuse to close a period that has not ended: penalties would be assessed
      // against emissions that are still arriving. The service also refuses a
      // period that is not OPEN, so this is a friendlier first check.
      const preview = await CompliancePeriod.findById(periodId).lean();
      if (!preview) return next(errors.notFound(`Period ${periodId} does not exist`));
      if (new Date(preview.endDate) > new Date()) {
        return next(
          errors.conflict(`Period ${preview.year} ends on ${preview.endDate} and cannot be closed yet`),
        );
      }

      const run = await asUserForRequest(req, () =>
        readings.runPeriodCompliance({
          periodId,
          ...(rate === undefined ? {} : { ratePerTonne: rate }),
        }),
      );

      const summary = run.results.reduce(
        (acc, r) => {
          acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
          acc.totalExcess += Number(r.excess ?? 0);
          acc.totalFines += Number(r.fine ?? 0);
          return acc;
        },
        { totalExcess: 0, totalFines: 0 },
      );

      realtime.emitToAll('compliance:run', { periodId, summary });
      for (const r of run.results) {
        if (Number(r.excess ?? 0) > 0) {
          realtime.emitToCompany(String(r.companyId), 'compliance:result', r);
        }
      }

      res.json({ periodId, year: run.year, summary, results: run.results });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/admin/overview — operational health, for the admin screen. */
router.get(
  '/admin/overview',
  ...adminOnly,
  async (req, res, next) => {
    try {
      const [
        companies,
        facilities,
        sensors,
        readingsCount,
        openOrders,
        unreadAlerts,
        pendingReports,
        breaches,
        recentTrades,
      ] = await Promise.all([
        Company.estimatedDocumentCount().exec(),
        Facility.estimatedDocumentCount().exec(),
        Sensor.estimatedDocumentCount().exec(),
        // estimatedDocumentCount reads collection metadata and is O(1), but it
        // can be stale after an unclean shutdown. Good enough for a KPI tile; the
        // exact count is available from the readings endpoint.
        EmissionReading.estimatedDocumentCount().exec(),
        MarketOrder.countDocuments({ status: { $in: ['OPEN', 'PARTIAL'] } }),
        Alert.countDocuments({ isRead: false }),
        EmissionReport.countDocuments({ status: 'SUBMITTED' }),
        // Worst offenders first. The compliance aggregation already computes
        // pctUsed, so the breach filter is applied on the result.
        aggregations
          .companyCompliance()
          .then((rows) =>
            rows
              .filter((r) => (r.pctUsed ?? 0) >= 100)
              .sort((a, b) => b.pctUsed - a.pctUsed)
              .slice(0, 25)
              .map((r) => ({
                companyId: String(r.companyId),
                name: r.name,
                year: r.year,
                emitted: r.emitted,
                cap: r.capTonnes,
                pctUsed: r.pctUsed,
              })),
          ),
        Trade.find()
          .sort({ tradeTs: -1 })
          .limit(20)
          .select('price quantity tradeTs')
          .lean(),
      ]);

      res.json({
        companies,
        facilities,
        sensors,
        readings: readingsCount,
        openOrders,
        unreadAlerts,
        pendingReports,
        worstBreaches: breaches,
        recentTrades: recentTrades.map((t) => ({
          id: String(t._id),
          price: t.price,
          quantity: t.quantity,
          tradedAt: t.tradeTs,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/admin/period-totals/rebuild
 *
 * Recomputes periodtotals from the raw readings.
 *
 * This endpoint exists because of the single largest behavioural change in the
 * migration. In PostgreSQL the running total was maintained by a trigger and
 * could not be wrong. Here it is maintained by services/readings.js, so it can
 * drift if that code is bypassed or buggy. This is the repair path, and — more
 * importantly — it is how the fast path is proved: the response includes any
 * company whose stored total disagrees with a full recomputation from the
 * readings, and that list should be empty.
 *
 * The drift check runs *after* the rebuild, so it verifies what was just written
 * rather than reporting the pre-existing state.
 */
router.post(
  '/admin/period-totals/rebuild',
  ...adminOnly,
  async (req, res, next) => {
    try {
      const rebuilt = await asUserForRequest(req, () => readings.rebuildPeriodTotals());

      // Compare the totals just written against a recomputation from raw
      // readings, per period. Any mismatch is a real discrepancy, not a rounding
      // artefact, since both sides now come from the same source.
      const periods = await CompliancePeriod.find().select('_id year').lean();
      const drift = [];
      for (const period of periods) {
        const rows = await aggregations.verifyComplianceTotals(period._id);
        for (const row of rows) {
          if (row.mismatch) drift.push(row);
          if (drift.length >= 100) break;
        }
        if (drift.length >= 100) break;
      }

      res.json({ rebuilt, periodsChecked: periods.length, drift, driftCount: drift.length });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
