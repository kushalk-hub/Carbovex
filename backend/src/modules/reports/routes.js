'use strict';

/**
 * GET   /api/reports              list reports
 * GET   /api/reports/queue        pending reports for the auditor view
 * POST  /api/reports              a company files its period report
 * PATCH /api/reports/:id/verify   the auditor's decision
 * GET   /api/reports/:id/audit    the decision and its provenance
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas } = require('../../middleware/validate');
const { requireAuth, requireRole, requireCompany, loadUser, asUserForRequest } = require('../../middleware/auth');
const { EmissionReport, Verification, Verifier, Company, CompliancePeriod, PeriodTotal, EmissionCap } = require('../../models');
const { transaction } = require('../../models/helpers');
const audit = require('../../services/audit');
const { aggregations } = require('../../services');
const realtime = require('../../realtime');

const router = express.Router();

/** The seeded internal reviewer, used when the acting account has no accreditation. */
const INTERNAL_REVIEWER = 'CX-INTERNAL-0001';

function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/** GET /api/reports */
router.get(
  '/',
  requireAuth,
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      const filter = {};
      if (user.role === 'COMPANY' && user.companyId) filter.companyId = user.companyId;

      const rows = await EmissionReport.find(filter)
        .sort({ submittedAt: -1 })
        .limit(200)
        .populate({ path: 'companyId', select: 'name' })
        .populate({ path: 'periodId', select: 'year' })
        .lean();

      // The verification is fetched in a second query rather than a nested
      // populate: it hangs off the report, and Mongoose cannot populate through a
      // field that is not on the model.
      const verifications = await Verification.find({
        reportId: { $in: rows.map((r) => r._id) },
      })
        .populate({ path: 'verifierId', select: 'name' })
        .lean();
      const byReport = new Map(verifications.map((v) => [String(v.reportId), v]));

      res.json({
        reports: rows.map((r) => {
          const v = byReport.get(String(r._id)) ?? null;
          return {
            id: String(r._id),
            companyId: String(r.companyId),
            company: r.companyId?.name ?? null,
            periodId: String(r.periodId),
            year: r.periodId?.year ?? null,
            totalTonnes: r.totalTonnes,
            status: r.status,
            submittedAt: r.submittedAt,
            verificationStatus: v?.decision ?? null,
            verificationRemarks: v?.remarks ?? null,
            verifiedAt: v?.verifiedAt ?? null,
            /* The accreditation body is reference data reached through the stored
               verifierId, never echoed from a request. The individual who clicked
               the button is not on this row by design: it is in the audit trail,
               written by services/audit.js. */
            verifierName: v?.verifierId?.name ?? null,
          };
        }),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/reports/queue — pending reports for the auditor view. */
router.get(
  '/queue',
  requireAuth,
  requireRole('AUDITOR', 'ADMIN'),
  async (req, res, next) => {
    try {
      const queue = await EmissionReport.aggregate([
        { $match: { status: 'SUBMITTED' } },
        { $lookup: { from: 'companies', localField: 'companyId', foreignField: '_id', as: 'company' } },
        { $unwind: '$company' },
        { $lookup: { from: 'sectors', localField: 'company.sectorId', foreignField: '_id', as: 'sector' } },
        { $lookup: { from: 'complianceperiods', localField: 'periodId', foreignField: '_id', as: 'period' } },
        { $unwind: '$period' },
        // The context an auditor needs to judge the report without a second call:
        // what the system recorded, and what the cap is.
        { $lookup: { from: 'periodtotals', localField: 'periodId', foreignField: 'periodId', as: 'total' } },
        { $lookup: { from: 'emissioncaps', localField: 'periodId', foreignField: 'periodId', as: 'cap' } },
        // Oldest first: a queue is a work list, and a report that has waited
        // longest is the one to clear.
        { $sort: { submittedAt: 1 } },
        {
          $project: {
            _id: 0,
            id: '$_id',
            companyId: '$companyId',
            company: '$company.name',
            sector: { $ifNull: [{ $first: '$sector.name' }, null] },
            year: '$period.year',
            deadline: '$period.deadline',
            totalTonnes: 1,
            submittedAt: 1,
            systemTonnes: { $ifNull: [{ $first: '$total.tonnes' }, 0] },
            cap: { $ifNull: [{ $first: '$cap.capTonnes' }, null] },
          },
        },
      ]).exec();

      res.json({ queue, count: queue.length });
    } catch (err) {
      return next(err);
    }
  },
);

/** POST /api/reports — a company files its period report. */
router.post(
  '/',
  requireAuth,
  requireCompany(),
  validate(schemas.submitReport),
  async (req, res, next) => {
    try {
      const { periodId, totalTonnes } = req.body;

      const report = await transaction(async (s) => {
        // Reject a filing for a period that has not ended: it would be
        // immediately stale, since readings keep arriving.
        const period = await CompliancePeriod.findById(periodId, null, { session: s }).lean();
        if (!period) throw errors.notFound(`Period ${periodId} does not exist`);

        if (new Date(period.endDate) > new Date()) {
          throw errors.conflict(
            `Period ${period.year} has not closed yet (ends ${period.endDate})`,
          );
        }

        // One report per company per period. The unique index on
        // (companyId, periodId) enforces it too, but checking here gives a
        // message that names the existing status rather than a 409 on an index.
        const existing = await EmissionReport.findOne({
          companyId: req.companyId,
          periodId,
        })
          .select('status')
          .session(s)
          .lean();
        if (existing) {
          throw errors.conflict(
            `A ${existing.status.toLowerCase()} report already exists for this period`,
          );
        }

        const created = await audit.applyInsert(
          EmissionReport,
          'emissionreports',
          {
            companyId: req.companyId,
            periodId,
            totalTonnes: Number(totalTonnes),
            status: 'SUBMITTED',
            submittedAt: new Date(),
          },
          { session: s },
        );
        return created;
      });

      realtime.emitToRole('AUDITOR', 'report:new', { reportId: String(report._id) });
      realtime.emitToCompany(String(req.companyId), 'report:submitted', {
        reportId: String(report._id),
      });

      res.status(201).json({
        report: {
          id: String(report._id),
          companyId: String(report.companyId),
          periodId: String(report.periodId),
          totalTonnes: report.totalTonnes,
          status: report.status,
          submittedAt: report.submittedAt,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * PATCH /api/reports/:id/verify
 *
 * The auditor identity is the authenticated user, never a field in the body. An
 * earlier design let the client post its own verifierId, which meant any caller
 * could record a verification under someone else's name.
 *
 * Two auditors clicking Approve at the same time is the interesting race, and it
 * is handled by the conditional status update rather than by a lock: only a report
 * still in SUBMITTED can transition, so the second one matches nothing and gets
 * a clean conflict instead of a duplicate-key error.
 */
router.patch(
  '/:id/verify',
  requireAuth,
  requireRole('AUDITOR', 'ADMIN'),
  validate(schemas.verifyReport),
  async (req, res, next) => {
    try {
      const user = await loadUser(req);
      const reportId = objectId(req.params.id, 'id');
      const { decision, remarks } = req.body;

      const result = await asUserForRequest(req, () =>
        transaction(async (s) => {
          const report = await EmissionReport.findById(reportId, null, { session: s }).lean();
          if (!report) throw errors.notFound(`Report ${reportId} does not exist`);

          if (report.status !== 'SUBMITTED') {
            throw errors.conflict(
              `Report is already ${report.status} and cannot be ${decision.toLowerCase()}`,
            );
          }

          // The accreditation body is resolved from the acting account, not taken
          // from the request. An AUDITOR always has one — the User model
          // validator enforces it. An ADMIN has none, so the decision is
          // attributed to the seeded internal reviewer rather than to an
          // arbitrary real body. Either way the individual is captured in the
          // audit trail.
          const verifierId =
            user.verifierId ??
            (await Verifier.findOne({ accreditationNo: INTERNAL_REVIEWER })
              .select('_id')
              .session(s)
              .lean())?._id;

          if (!verifierId) {
            // The internal reviewer is missing, which means the seed did not run.
            // Failing loudly beats attributing a decision to a real body by
            // accident, which is what a bare `?? someDefaultId` would do.
            throw errors.internal(
              `No accreditation on this account and no verifier with accreditation number ` +
                `${INTERNAL_REVIEWER}. Run \`npm run db:seed\`.`,
            );
          }

          // APPROVED/REJECTED are the verifier's wording; the report's own status
          // vocabulary is DRAFT/SUBMITTED/VERIFIED/REJECTED, so they are mapped
          // rather than copied.
          const nextStatus = decision === 'APPROVED' ? 'VERIFIED' : 'REJECTED';

          // The transition is conditional on the report still being SUBMITTED, so
          // a concurrent verification cannot also move it.
          const updated = await EmissionReport.findOneAndUpdate(
            { _id: reportId, status: 'SUBMITTED' },
            { $set: { status: nextStatus } },
            { session: s, new: true },
          ).lean();

          if (!updated) {
            throw errors.conflict('Another verification was recorded for this report first');
          }

          const verifierName = await Verifier.findById(verifierId, null, { session: s })
            .select('name')
            .lean();

          const verification = await audit.applyInsert(
            Verification,
            'verifications',
            {
              reportId,
              verifierId,
              decision,
              remarks,
              verifiedAt: new Date(),
            },
            { session: s },
          );

          return {
            report: updated,
            verification: { ...verification, verifierName: verifierName?.name ?? null },
            companyId: report.companyId,
          };
        }),
      );

      const verb = decision === 'APPROVED' ? 'report:approved' : 'report:rejected';
      realtime.emitToCompany(String(result.companyId), verb, { reportId, decision, remarks });

      res.json({
        report: { id: String(result.report._id), status: result.report.status },
        verification: {
          id: String(result.verification._id),
          decision: result.verification.decision,
          remarks: result.verification.remarks,
          verifiedAt: result.verification.verifiedAt,
          verifierName: result.verification.verifierName,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/reports/:id/audit — the decision, the body, and the report it covers. */
router.get(
  '/:id/audit',
  requireAuth,
  requireRole('ADMIN', 'AUDITOR'),
  async (req, res, next) => {
    try {
      const reportId = objectId(req.params.id, 'id');
      const [auditRow] = await aggregations.reportAudit(reportId);
      res.json({ audit: auditRow ?? null });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
