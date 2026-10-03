'use strict';

/**
 * GET  /api/wallet            balances
 * GET  /api/wallet/holdings   credits by batch (what can be sold now)
 * GET  /api/wallet/ledger     paginated credit history
 * POST /api/wallet/retire     voluntary retirement
 * GET  /api/wallet/retirements  the compliance record of what was surrendered
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas, q } = require('../../middleware/validate');
const { requireAuth, requireCompany, asUserForRequest } = require('../../middleware/auth');
const { CreditAccount, CreditRetirement, CompliancePeriod, CreditBatch, OffsetProject, CreditLedger } = require('../../models');
const { credits: creditService, aggregations } = require('../../services');
const realtime = require('../../realtime');
const { one, many, page } = require('../shape');

const router = express.Router();

/** Every route in this module is company-scoped, so enforce it once. */
router.use(requireAuth, requireCompany());

/**
 * Load the caller's wallet without creating it.
 *
 * Deliberately does *not* use the service's ensureAccount: a missing wallet is a
 * real problem worth reporting, and silently creating one at zero would turn a
 * provisioning bug into a plausible-looking empty balance.
 */
async function walletFor(companyId) {
  const account = await CreditAccount.findOne({ companyId }).lean();
  if (!account) {
    throw errors.notFound(`No credit account exists for company ${companyId}`);
  }
  return one(account);
}

/** GET /api/wallet */
router.get(
  '/',
  async (req, res, next) => {
    try {
      res.json(await walletFor(req.companyId));
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/wallet/holdings
 *
 * The aggregation already excludes expired batches, so this list is exactly
 * "credits I can sell right now" — not "credits I have ever received", which is
 * what a naive sum over the ledger would return.
 *
 * The per-batch project and registry details are joined here rather than in the
 * pipeline, because the pipeline is also used by the trading engine on the hot
 * path where those joins are pure overhead.
 */
router.get(
  '/holdings',
  async (req, res, next) => {
    try {
      const holdings = await aggregations.creditHoldings(req.companyId);

      if (holdings.length === 0) {
        return res.json({ companyId: req.companyId, holdings: [], totalQuantity: 0, byVintage: {} });
      }

      // Batch -> project -> type/registry/location, in three queries rather than
      // one per holding.
      const batchIds = holdings.map((h) => h.batchId);
      const batches = await CreditBatch.find({ _id: { $in: batchIds } })
        .populate({ path: 'projectId', populate: { path: 'projectTypeId registryId cityId' } })
        .lean();

      const byBatch = new Map(batches.map((b) => [String(b._id), b]));

      const enriched = holdings.map((h) => {
        const batch = byBatch.get(String(h.batchId));
        const project = batch?.projectId ?? null;
        const city = project?.cityId ?? null;
        // The SQL used CONCAT_WS(', ', city, state) to build the location string.
        // stateName is denormalised onto the city document for exactly this.
        const location = [city?.name, city?.stateName].filter(Boolean).join(', ') || null;

        return {
          batchId: String(h.batchId),
          vintage: h.vintageYear,
          quantity: h.qty,
          expiresAfter: h.expiryYear ?? null,
          project: project?.name ?? null,
          projectType: project?.projectTypeId?.name ?? null,
          registry: project?.registryId?.name ?? null,
          location,
          estAnnualCredits: project?.estAnnualCredits ?? null,
        };
      });

      // Newest vintage first, matching the original ORDER BY.
      enriched.sort((a, b) => b.vintage - a.vintage);

      const byVintage = {};
      let totalQuantity = 0;
      for (const h of enriched) {
        byVintage[h.vintage] = (byVintage[h.vintage] ?? 0) + h.quantity;
        totalQuantity += h.quantity;
      }

      res.json({ companyId: req.companyId, holdings: enriched, totalQuantity, byVintage });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/wallet/ledger
 *
 * The ledger is append-only — a model guard refuses updates and deletes, and the
 * carbonx_app role has no such privileges — so this is a complete and honest
 * history. Corrections are new rows, never edits.
 */
router.get(
  '/ledger',
  validate(schemas.ledgerQuery, 'query'),
  async (req, res, next) => {
    try {
      const { limit, offset } = q(req);

      // Counted with the same filter as the page, or the total would describe a
      // different set than the items and the frontend's pager would lie.
      const [rows, total] = await Promise.all([
        CreditLedger.find({ companyId: req.companyId })
          .sort({ createdAt: -1, _id: -1 })
          .skip(offset)
          .limit(limit)
          .populate({ path: 'batchId', populate: { path: 'projectId', select: 'name' } })
          .lean(),
        CreditLedger.countDocuments({ companyId: req.companyId }),
      ]);

      const entries = rows.map((l) => {
        const batch = l.batchId ?? null;
        return {
          id: String(l._id),
          type: l.txnType,
          quantity: l.quantity,
          tradeId: l.refTradeId ? String(l.refTradeId) : null,
          createdAt: l.createdAt,
          batchId: batch ? String(batch._id) : null,
          vintage: batch?.vintageYear ?? null,
          project: batch?.projectId?.name ?? null,
        };
      });

      res.json({ companyId: req.companyId, entries, total, limit, offset });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/wallet/retire
 *
 * Delegates the batch loop to the service, which picks oldest-vintage-first and
 * writes the ledger, the retirement record and the wallet in one transaction.
 * Reimplementing that loop in the route is exactly the kind of thing that ends
 * up half-done without a transaction.
 *
 * Wrapped in asUserForRequest so the ledger rows are attributed to the caller.
 * In PostgreSQL the audit trigger read a session variable set by the pool; here
 * the attribution comes from AsyncLocalStorage, which the request middleware
 * establishes per request.
 */
router.post(
  '/retire',
  validate(schemas.retire),
  async (req, res, next) => {
    try {
      const { quantity, periodId } = req.body;

      // Default to the oldest still-open period: retiring against a specific
      // period is allowed, but "retire for the current compliance year" is what
      // callers actually mean, and making them look it up first would just get
      // it wrong.
      let effectivePeriodId = periodId;
      if (!effectivePeriodId) {
        const open = await CompliancePeriod.findOne({ status: 'OPEN' }).sort({ year: 1 }).select('_id').lean();
        effectivePeriodId = open ? open._id : null;
      }

      const result = await asUserForRequest(req, () =>
        creditService.retireCredits({
          companyId: req.companyId,
          quantity,
          periodId: effectivePeriodId,
        }),
      );

      // Retirement changes this company's position, and the compliance picture
      // for everyone watching that company.
      const wallet = await walletFor(req.companyId);
      realtime.emitWallet(req.companyId, wallet);
      realtime.emitToAll('compliance:update', {
        companyId: req.companyId,
        retired: result.retired,
        periodId: effectivePeriodId ? String(effectivePeriodId) : null,
      });

      res.status(201).json({
        retirement: {
          companyId: req.companyId,
          requested: quantity,
          retired: result.retired,
          // A partial retirement is not an error: the wallet simply did not hold
          // the full amount, and the caller is told exactly what was taken.
          partial: result.retired < quantity,
          periodId: effectivePeriodId ? String(effectivePeriodId) : null,
          createdAt: new Date().toISOString(),
        },
        wallet,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/wallet/retirements — the compliance record of what was surrendered. */
router.get(
  '/retirements',
  async (req, res, next) => {
    try {
      const rows = await CreditRetirement.find({ companyId: req.companyId })
        .sort({ retiredAt: -1 })
        .limit(200)
        .populate({
          path: 'batchId',
          populate: { path: 'projectId', select: 'name' },
        })
        .populate({ path: 'periodId', select: 'year' })
        .lean();

      const retirements = rows.map((r) => ({
        id: String(r._id),
        quantity: r.quantity,
        periodId: r.periodId ? String(r.periodId) : null,
        year: r.periodId?.year ?? null,
        createdAt: r.retiredAt,
        vintage: r.batchId?.vintageYear ?? null,
        project: r.batchId?.projectId?.name ?? null,
      }));

      res.json({ companyId: req.companyId, retirements });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
module.exports.walletFor = walletFor;
