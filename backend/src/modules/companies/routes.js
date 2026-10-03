'use strict';

/**
 * GET /api/companies                    list / search
 * GET /api/companies/:id/compliance     cap vs emitted per period, plus penalties
 * GET /api/companies/:id/dashboard      one bundle for the 3D detail panel
 */

const express = require('express');
const { requireAuth, requireCompany, loadUser } = require('../../middleware/auth');
const { validate, schemas, q } = require('../../middleware/validate');
const { errors } = require('../../middleware/errors');
const {
  Company,
  Sector,
  CreditAccount,
  CompliancePeriod,
  EmissionCap,
  PeriodTotal,
  EmissionReport,
  Verification,
  Verifier,
  Penalty,
  Facility,
  MarketOrder,
  Alert,
} = require('../../models');
const { aggregations } = require('../../services');

const router = express.Router();

/** ObjectId, or a 400 that names the field. */
function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/**
 * A case-insensitive substring match on name or registration number.
 *
 * The SQL used `ILIKE '%' || $1 || '%'`, which cannot use an index — every search
 * was a sequential scan with a per-row pattern match. Here a regex built from the
 * caller's input serves the same semantics, and the compound text index on
 * (name, regNumber) can serve the anchored form. Escaped because a user-supplied
 * string is unescaped regex by default, and an unescaped `.` or `*` would match
 * far more than the caller intended.
 */
function searchPattern(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

/** GET /api/companies */
router.get(
  '/',
  requireAuth,
  validate(schemas.companyQuery, 'query'),
  async (req, res, next) => {
    try {
      const { search, sector, limit, offset } = q(req);

      const filter = {};
      if (search) filter.$or = [{ name: searchPattern(search) }, { regNumber: searchPattern(search) }];
      if (sector) {
        const sectorDoc = await Sector.findOne({ name: sector }).select('_id').lean();
        // An unknown sector name matches nothing, rather than silently dropping
        // the filter and returning every company.
        filter.sectorId = sectorDoc ? sectorDoc._id : null;
      }

      const [rows, total] = await Promise.all([
        Company.find(filter)
          .sort({ name: 1 })
          .skip(offset)
          .limit(limit)
          .populate({ path: 'sectorId', select: 'name' })
          .lean(),
        Company.countDocuments(filter),
      ]);

      const companies = rows.map((c) => ({
        id: String(c._id),
        name: c.name,
        regNumber: c.regNumber,
        status: c.status,
        sector: c.sectorId?.name ?? null,
      }));

      res.json({ companies, total, limit, offset });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/companies/:id/compliance
 *
 * Cap vs emitted per period, plus the penalties levied. Reads the incrementally
 * maintained periodtotals, so this is O(periods) rather than a scan of every
 * reading.
 *
 * Scope: a COMPANY may only read its own row, and the response deliberately omits
 * the wallet. Cap position is a compliance fact that the auditor, the regulator
 * and the company all need to see; a cash and credit balance is not, and it is
 * already served by /api/wallet. An earlier version of this route was
 * authenticated-but-not-scoped, which meant any logged-in company could read any
 * other company's balances by guessing an id.
 */
router.get(
  '/:id/compliance',
  requireAuth,
  requireCompany({ param: 'id', allow: ['ADMIN', 'AUDITOR'] }),
  async (req, res, next) => {
    try {
      const companyId = objectId(req.params.id, 'id');

      const company = await Company.findById(companyId)
        .populate({ path: 'sectorId', select: 'name' })
        .lean();
      if (!company) return next(errors.notFound(`Company ${companyId} does not exist`));

      // Every period, LEFT-joined to this company's cap, total and report — so a
      // period with no cap still appears, as zero, rather than vanishing. The
      // SQL did the same with a chain of LEFT JOINs from compliance_period.
      const periods = await CompliancePeriod.aggregate([
        {
          $lookup: {
            from: 'emissioncaps',
            let: { company: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$companyId', '$$company'] } } },
            ],
            as: 'cap',
          },
        },
        { $lookup: { from: 'periodtotals', localField: '_id', foreignField: 'periodId', as: 'total' } },
        { $lookup: { from: 'emissionreports', localField: '_id', foreignField: 'periodId', as: 'report' } },
        { $sort: { year: -1 } },
        {
          $project: {
            _id: 0,
            periodId: '$_id',
            year: 1,
            startDate: 1,
            endDate: 1,
            deadline: 1,
            // NULLIF(cap, 0) in the SQL: a zero cap would divide by zero. The
            // schema forbids a zero cap (min: MIN_VALUE), but $round on an
            // infinite ratio is still avoided explicitly.
            cap: { $ifNull: [{ $first: '$cap.capTonnes' }, null] },
            emitted: { $ifNull: [{ $first: '$total.tonnes' }, 0] },
          },
        },
        {
          $addFields: {
            headroom: { $cond: [{ $eq: ['$cap', null] }, null, { $subtract: ['$cap', '$emitted'] }] },
            pctUsed: {
              $cond: [
                { $or: [{ $eq: ['$cap', null] }, { $lte: ['$cap', 0] }] },
                null,
                { $round: [{ $multiply: [{ $divide: ['$emitted', '$cap'] }, 100] }, 1] },
              ],
            },
            reportId: { $ifNull: [{ $first: '$report._id' }, null] },
            reportStatus: { $ifNull: [{ $first: '$report.status' }, null] },
          },
        },
        // The verification decision, reached through the report.
        {
          $lookup: {
            from: 'verifications',
            let: { report: '$reportId' },
            pipeline: [{ $match: { $expr: { $eq: ['$reportId', '$$report'] } } }],
            as: 'verification',
          },
        },
        {
          $lookup: {
            from: 'verifiers',
            localField: 'verification.verifierId',
            foreignField: '_id',
            as: 'verifier',
          },
        },
        {
          $project: {
            reportId: 1,
            year: 1,
            startDate: 1,
            endDate: 1,
            deadline: 1,
            cap: 1,
            emitted: 1,
            headroom: 1,
            pctUsed: 1,
            reportStatus: 1,
            verificationStatus: { $ifNull: [{ $first: '$verification.decision' }, null] },
            verifierName: { $ifNull: [{ $first: '$verifier.name' }, null] },
          },
        },
      ]).exec();

      const [penalties, facilities] = await Promise.all([
        Penalty.find({ companyId })
          .sort({ issuedAt: -1 })
          .lean(),
        Facility.find({ companyId })
          .sort({ name: 1 })
          .populate({ path: 'cityId', select: 'name stateName' })
          .lean(),
      ]);

      res.json({
        company: {
          id: String(company._id),
          name: company.name,
          status: company.status,
          sector: company.sectorId?.name ?? null,
        },
        periods,
        penalties: penalties.map((p) => ({
          id: String(p._id),
          periodId: String(p.periodId),
          excessTonnes: p.excessTonnes,
          ratePerTonne: p.ratePerTonne,
          fineAmount: p.fineAmount,
          status: p.status,
          issuedAt: p.issuedAt,
        })),
        facilities: facilities.map((f) => ({
          id: String(f._id),
          name: f.name,
          latitude: f.latitude,
          longitude: f.longitude,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/companies/:id/dashboard
 *
 * One request for the whole company detail view. The frontend would otherwise
 * fire seven parallel requests and race them.
 */
router.get(
  '/:id/dashboard',
  requireAuth,
  requireCompany({ param: 'id', allow: ['ADMIN', 'AUDITOR'] }),
  async (req, res, next) => {
    try {
      const companyId = objectId(req.params.id, 'id');

      // The guard already resolved the caller's own company onto req.companyId,
      // so "is this the caller's own company" is a comparison, not a lookup.
      const caller = await loadUser(req);
      const maySeeWallet =
        caller.role === 'ADMIN' || String(caller.companyId) === String(companyId);

      const [company, wallet, compliance, holdings, orders, alerts, facilities] = await Promise.all([
        Company.findById(companyId).populate({ path: 'sectorId', select: 'name' }).lean(),

        // Balances are not a compliance fact, so they are only fetched for a
        // caller entitled to the wallet: the company itself, or an admin. An
        // auditor sees cap position, not anyone's money.
        maySeeWallet
          ? CreditAccount.findOne({ companyId }).select('creditBalance cashBalance updatedAt').lean()
          : Promise.resolve(null),

        aggregations
          .companyCompliance({ companyId })
          .then((rows) =>
            rows.map((r) => ({
              year: r.year,
              cap: r.capTonnes,
              emitted: r.emitted,
              pctUsed: r.pctUsed,
            })),
          ),

        aggregations.creditHoldings(companyId),

        MarketOrder.find({ companyId })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),

        Alert.find({ companyId })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),

        Facility.find({ companyId })
          .sort({ name: 1 })
          .select('name latitude longitude')
          .lean(),
      ]);

      if (!company) return next(errors.notFound(`Company ${companyId} does not exist`));

      res.json({
        company: {
          id: String(company._id),
          name: company.name,
          status: company.status,
          sector: company.sectorId?.name ?? null,
        },
        wallet: wallet
          ? {
              creditBalance: wallet.creditBalance,
              cashBalance: wallet.cashBalance,
              updatedAt: wallet.updatedAt,
            }
          : null,
        compliance,
        holdings: holdings.map((h) => ({
          batchId: String(h.batchId),
          vintage: h.vintageYear,
          quantity: h.qty,
        })),
        orders: orders.map((o) => ({
          id: String(o._id),
          side: o.side,
          quantity: o.quantity,
          filledQty: o.filledQty,
          price: o.pricePerCredit,
          status: o.status,
          createdAt: o.createdAt,
        })),
        alerts: alerts.map((a) => ({
          id: String(a._id),
          type: a.alertType,
          message: a.message,
          createdAt: a.createdAt,
          isRead: a.isRead,
        })),
        facilities: facilities.map((f) => ({
          id: String(f._id),
          name: f.name,
          latitude: f.latitude,
          longitude: f.longitude,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
