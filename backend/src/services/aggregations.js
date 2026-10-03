'use strict';

/**
 * Aggregation pipelines replacing legacy-postgres/03_views.sql.
 *
 * Every view became a function here rather than a query inline in a route. Two
 * reasons, and the second is the important one:
 *
 *   1. The SQL views were named definitions reused by several routes, and
 *      inlining them would have meant copy-pasting a pipeline and then fixing
 *      the same bug four times.
 *   2. Some of these need a $lookup against another collection, and $lookup is
 *      not composable in a query string. A shared builder is the only sane way.
 *
 * The functions take an optional session so a caller inside a transaction gets
 * a consistent snapshot. MongoDB does not give snapshot isolation across
 * aggregations inside a transaction in the way Postgres did, so read paths
 * outside a transaction may see a slightly newer total than a preceding write —
 * acceptable for a dashboard, and never used on a settlement path.
 *
 * A note on the per-period views: v_facility_period_emission CROSS JOINed
 * facilities against periods to show facilities with no readings as zero. The
 * equivalent $lookup from facilities to periods with no match would DROP those
 * rows, so the pipeline builds the facility x period grid explicitly. That
 * behaviour is intentional in the SQL and easy to lose in a port.
 */

const mongoose = require('mongoose');
const { errors } = require('../middleware/errors');
const models = require('../models');

const { Facility, EmissionReading, CreditLedger, EmissionCap, Company, CompliancePeriod, PeriodTotal, MarketOrder, Trade, AuditLog, Verification } = models;

/** Cast to ObjectId, or throw a clean 400 rather than a BSON cast error. */
function oid(value, field = 'id') {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  throw errors.badRequest(`Invalid ${field}: ${value}`);
}

/**
 * $lookup into a collection by a local field.
 *
 * `foreignField` defaults to '_id' because almost every reference in this schema
 * points at _id. It has to be passed explicitly rather than inferred: MongoDB
 * requires either a pipeline or *both* localField and foreignField, and omitting
 * it fails the whole aggregation with a server-side error rather than a helpful
 * one.
 */
const lookup = (from, localField, as, pipeline) => ({
  $lookup: {
    from,
    localField,
    foreignField: '_id',
    as,
    ...(pipeline ? { pipeline } : {}),
  },
});

/** Match on a date range. MongoDB has no date_trunc on the server side, so ranges are explicit. */
const dateRange = (from, to) => ({ $gte: from, $lt: to });

/**
 * v_credit_holdings — what a company can actually sell right now.
 *
 * Sums the ledger per (company, batch) and keeps only positive balances on
 * batches that are still active and unexpired. The `HAVING SUM > 0` in SQL
 * becomes a $match after the $group, because $group's output cannot be filtered
 * in the same stage.
 */
async function creditHoldings(companyId, { session = null, includeExpired = false } = {}) {
  const company = oid(companyId, 'companyId');
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  const batchMatch = { status: 'ACTIVE' };
  if (!includeExpired) {
    // NULL expiry means non-expiring, so an $or rather than a plain comparison.
    batchMatch.$or = [{ expiryYear: null }, { expiryYear: { $gte: currentYear } }];
  }

  const rows = await CreditLedger.aggregate(
    [
      { $match: { companyId: company } },
      lookup('creditbatches', 'batchId', 'batch', [{ $match: batchMatch }]),
      { $unwind: '$batch' },
      {
        $group: {
          _id: { companyId: '$companyId', batchId: '$batchId' },
          vintageYear: { $first: '$batch.vintageYear' },
          batchExpiryYear: { $first: '$batch.expiryYear' },
          qty: { $sum: '$quantity' },
        },
      },
      // HAVING SUM(l.quantity) > 0
      { $match: { qty: { $gt: 0 } } },
      { $sort: { vintageYear: 1, '_id.batchId': 1 } },
      {
        $project: {
          _id: 0,
          companyId: '$_id.companyId',
          batchId: '$_id.batchId',
          vintageYear: 1,
          expiryYear: '$batchExpiryYear',
          qty: 1,
        },
      },
    ],
    { session },
  ).exec();

  return rows;
}

/**
 * v_facility_period_emission — emissions per facility per period.
 *
 * The SQL cross-joined facilities against periods so a facility with no readings
 * appeared as 0 rather than vanishing. To keep that here the pipeline loads the
 * periods, then for each facility matches readings against each period window.
 * It is a $facet-free approach on purpose: at the row counts involved (facilities
 * x years) an explicit loop is clearer than a clever pipeline, and it keeps the
 * zero-rows behaviour visible.
 */
async function facilityPeriodEmission(facilityId, periodId, { session = null } = {}) {
  const facility = oid(facilityId, 'facilityId');
  const period = await CompliancePeriod.findById(oid(periodId, 'periodId'), null, { session }).lean();
  if (!period) throw errors.notFound(`Compliance period ${periodId} not found`);

  const agg = await EmissionReading.aggregate(
    [
      { $match: { facilityId: facility, readingTs: dateRange(period.startDate, endExclusive(period.endDate)) } },
      { $group: { _id: null, emitted: { $sum: '$co2Tonnes' }, readings: { $sum: 1 } } },
    ],
    { session },
  ).exec();

  return {
    facilityId: facility,
    periodId: period._id,
    year: period.year,
    // COALESCE(SUM(...), 0): no readings is zero, not missing.
    emitted: agg.length ? agg[0].emitted : 0,
    readings: agg.length ? agg[0].readings : 0,
  };
}

/** endDate is inclusive in the schema, so the range end is the next millisecond. */
function endExclusive(endDate) {
  return new Date(new Date(endDate).getTime() + 1);
}

/**
 * v_company_compliance — emissions vs cap, reading the running total.
 *
 * Uses periodtotal rather than re-summing readings, exactly as the SQL did: this
 * is the O(companies x periods) path. verifyComplianceTotals() below is the
 * check that the shortcut is not lying.
 */
async function companyCompliance({ periodId = null, companyId = null, session = null } = {}) {
  const match = {};
  if (periodId) match.periodId = oid(periodId, 'periodId');
  if (companyId) match.companyId = oid(companyId, 'companyId');

  const rows = await EmissionCap.aggregate(
    [
      { $match: match },
      lookup('companies', 'companyId', 'company'),
      lookup('complianceperiods', 'periodId', 'period'),
      lookup('sectors', 'company.sectorId', 'sector'),
      lookup(
        'periodtotals',
        'companyId',
        'total',
        [{ $match: periodId ? { periodId: oid(periodId, 'periodId') } : {} }],
      ),
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$period', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$sector', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          companyId: 1,
          name: '$company.name',
          sector: { $ifNull: ['$sector.name', null] },
          periodId: '$period._id',
          year: '$period.year',
          capTonnes: '$capTonnes',
          // COALESCE(pt.tonnes, 0): a company with no readings has emitted zero.
          emitted: { $ifNull: [{ $first: '$total.tonnes' }, 0] },
        },
      },
      {
        $addFields: {
          headroom: { $subtract: ['$capTonnes', { $ifNull: [{ $first: '$total.tonnes' }, 0] }] },
          // ROUND(100 * emitted / cap, 1) — cap is positive by the schema's min.
          pctUsed: {
            $round: [{ $multiply: [{ $divide: [{ $ifNull: [{ $first: '$total.tonnes' }, 0] }, '$capTonnes'] }, 100] }, 1],
          },
        },
      },
      { $sort: { year: -1, companyId: 1 } },
    ],
    { session },
  ).exec();

  return rows;
}

/**
 * v_company_compliance_audit — the same figures recomputed from raw readings.
 *
 * Never called by a route. It exists so the incremental total in
 * periodtotals can be proven correct rather than assumed correct, which is the
 * one thing that changed in substance by moving off triggers:
 *
 *   const rows = await verifyComplianceTotals(periodId);
 *   rows.filter(r => r.mismatch)  // must be empty
 */
async function verifyComplianceTotals(periodId, { session = null } = {}) {
  const period = await CompliancePeriod.findById(oid(periodId, 'periodId'), null, { session }).lean();
  if (!period) throw errors.notFound(`Compliance period ${periodId} not found`);

  const range = dateRange(period.startDate, endExclusive(period.endDate));

  // The authoritative figure: sum readings, attributed to the owning company by
  // way of the facility. This is a $lookup, not a stored value.
  const actual = await EmissionReading.aggregate(
    [
      { $match: { readingTs: range } },
      lookup('facilities', 'facilityId', 'facility'),
      { $unwind: '$facility' },
      { $group: { _id: '$facility.companyId', actual: { $sum: '$co2Tonnes' } } },
    ],
    { session },
  ).exec();

  const actualByCompany = new Map(actual.map((r) => [String(r._id), r.actual]));
  const fast = await companyCompliance({ periodId, session });

  return fast.map((row) => {
    const actualTonnes = actualByCompany.get(String(row.companyId)) ?? 0;
    // Compare as numbers, not strings. Mongoose returns Decimal128 as
    // Decimal128 and Number as number; the legacy schema used NUMERIC, so a
    // naive === would compare "1234" to 1234 and always report a mismatch.
    const fastTonnes = Number(row.emitted ?? 0);
    return {
      companyId: row.companyId,
      name: row.name,
      periodId: row.periodId,
      fastEmitted: fastTonnes,
      actualEmitted: Number(actualTonnes),
      // Tolerance absorbs float accumulation, which NUMERIC did not have.
      mismatch: Math.abs(fastTonnes - Number(actualTonnes)) > 0.01,
    };
  });
}

/**
 * v_order_book — resting orders, best price first.
 *
 * `remaining` is derived (quantity - filledQty) and filtered positive, matching
 * the SQL's `quantity - filled_qty AS remaining` over statuses OPEN/PARTIAL.
 */
async function orderBook({ side = null, limit = 200, session = null } = {}) {
  const match = { status: { $in: ['OPEN', 'PARTIAL'] } };
  if (side) match.side = side;

  return MarketOrder.aggregate(
    [
      { $match: match },
      {
        $addFields: {
          remaining: { $subtract: ['$quantity', '$filledQty'] },
        },
      },
      { $match: { remaining: { $gt: 0 } } },
      // Price-time priority: best price first, then the order that rested first.
      { $sort: { side: -1, pricePerCredit: side === 'SELL' ? 1 : -1, createdAt: 1, _id: 1 } },
      { $limit: Math.min(Number(limit) || 200, 1000) },
      {
        $project: {
          _id: 0,
          orderId: '$_id',
          companyId: 1,
          side: 1,
          pricePerCredit: 1,
          remaining: 1,
          createdAt: 1,
        },
      },
    ],
    { session },
  ).exec();
}

/**
 * v_sector_rank — leaderboard within each sector and year.
 *
 * $setWindowFields is the $denseRANK/ROW_NUMBER equivalent; $rank here matches
 * SQL RANK(), where tied companies share a rank and the next rank skips.
 *
 * Companies with no sector are grouped under 'Unclassified', which is why the
 * partition key uses the coalesced name rather than the sector id.
 */
async function sectorRank({ periodId = null, session = null } = {}) {
  const base = await companyCompliance({ periodId, session });
  if (base.length === 0) return [];

  const withSector = base.map((row) => ({
    companyId: row.companyId,
    company: row.name,
    year: row.year,
    emitted: Number(row.emitted ?? 0),
    pctUsed: row.pctUsed ?? null,
    sector: row.sector || 'Unclassified',
  }));

  return withSector;
}

/**
 * Rank within sector, done in JS because the partition key spans a $lookup.
 *
 * The SQL used a window function over the compliance view. Here the rows are
 * already assembled, so a group-and-sort is both simpler and faster than pushing
 * a $setWindowFields stage through the driver. Rank ties are handled explicitly.
 */
function rankSectors(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.sector}|${row.year}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const out = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => b.emitted - a.emitted);
    let rank = 0;
    let previous = null;
    group.forEach((row, index) => {
      if (row.emitted !== previous) {
        rank = index + 1; // SQL RANK(): ties share a rank, then skip
        previous = row.emitted;
      }
      out.push({ ...row, rankInSector: rank });
    });
  }
  return out;
}

/** mv_monthly_emission — monthly rollup per facility, for GET /readings?bucket=month. */
async function monthlyEmission(facilityId, { from = null, to = null, session = null } = {}) {
  const facility = oid(facilityId, 'facilityId');
  const match = { facilityId: facility };
  if (from || to) {
    match.readingTs = {};
    if (from) match.readingTs.$gte = from;
    if (to) match.readingTs.$lt = to;
  }

  return EmissionReading.aggregate(
    [
      { $match: match },
      {
        $group: {
          // $dateTrunc exists in MongoDB 5.0+, but a $year/$month group avoids
          // depending on it and is cheaper over an index-assisted match.
          _id: {
            year: { $year: '$readingTs' },
            month: { $month: '$readingTs' },
          },
          tonnes: { $sum: '$co2Tonnes' },
          readings: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          tonnes: 1,
          readings: 1,
        },
      },
    ],
    { session },
  ).exec();
}

/** Period totals for a company across every period, for the dashboard. */
async function periodTotals(companyId, { session = null } = {}) {
  return PeriodTotal.aggregate(
    [
      { $match: { companyId: oid(companyId, 'companyId') } },
      lookup('complianceperiods', 'periodId', 'period'),
      { $unwind: '$period' },
      { $project: { _id: 0, periodId: '$period._id', year: '$period.year', tonnes: 1 } },
      { $sort: { year: 1 } },
    ],
    { session },
  ).exec();
}

/** Trade history for a company, joined to the counterparty for the UI. */
async function tradeHistory(companyId, { limit = 50, session = null } = {}) {
  const company = oid(companyId, 'companyId');
  return Trade.aggregate(
    [
      { $match: { $or: [{ 'buy.companyId': company }, { 'sell.companyId': company }] } },
      lookup('marketorders', 'buyOrderId', 'buy'),
      lookup('marketorders', 'sellOrderId', 'sell'),
      { $unwind: { path: '$buy', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$sell', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          tradeId: '$_id',
          quantity: 1,
          price: 1,
          tradeTs: 1,
          side: {
            $cond: [{ $eq: ['$buy.companyId', company] }, 'BUY', 'SELL'],
          },
          counterpartyId: {
            $cond: [{ $eq: ['$buy.companyId', company] }, '$sell.companyId', '$buy.companyId'],
          },
        },
      },
      { $sort: { tradeTs: -1 } },
      { $limit: Math.min(Number(limit) || 50, 500) },
    ],
    { session },
  ).exec();
}

/** Company list with sector and wallet balances, for the admin table. */
async function companiesWithBalances({ session = null } = {}) {
  return Company.aggregate(
    [
      lookup('sectors', 'sectorId', 'sector'),
      lookup('creditaccounts', 'companyId', 'account'),
      {
        $project: {
          _id: 0,
          companyId: '$_id',
          name: 1,
          status: 1,
          sector: { $ifNull: [{ $first: '$sector.name' }, 'Unclassified'] },
          creditBalance: { $ifNull: [{ $first: '$account.creditBalance' }, 0] },
          cashBalance: { $ifNull: [{ $first: '$account.cashBalance' }, 0] },
        },
      },
      { $sort: { name: 1 } },
    ],
    { session },
  ).exec();
}

/** Audit trail with the acting user's name resolved, for GET /audit. */
async function auditTrail({ tableName = null, limit = 100, changedBy = null, session = null } = {}) {
  const match = {};
  if (tableName) match.tableName = tableName;
  if (changedBy) match.changedBy = oid(changedBy, 'changedBy');

  return AuditLog.aggregate(
    [
      { $match: match },
      lookup('users', 'changedBy', 'actor'),
      {
        $project: {
          _id: 0,
          tableName: 1,
          operation: 1,
          rowPk: 1,
          oldData: 1,
          newData: 1,
          changedAt: 1,
          changedBy: '$changedBy',
          changedByName: { $ifNull: [{ $first: '$actor.fullName' }, null] },
        },
      },
      { $sort: { changedAt: -1 } },
      { $limit: Math.min(Number(limit) || 100, 1000) },
    ],
    { session },
  ).exec();
}

/**
 * Emissions and cap per compliance year, for one facility.
 *
 * The SQL cross-joined the facility against every compliance period so a year
 * with no readings appeared as zero rather than dropping out of the history. That
 * behaviour is preserved here by driving the loop from the periods: a $lookup
 * from facilities to periods would only ever return matching rows, and a facility
 * with no readings would have no rows to join to.
 *
 * Emissions here are attributed by summing the readings of the facility itself,
 * not by reading the company's periodtotal. That is deliberate and is the reason
 * this endpoint is slower than the company-level one: the figure is per facility,
 * and the incremental total is only maintained per company.
 */
async function facilityEmissionByYear(facilityId, { session = null } = {}) {
  const facility = oid(facilityId, 'facilityId');

  const facilityDoc = await Facility.findById(facility, null, { session }).lean();
  if (!facilityDoc) throw errors.notFound(`Facility ${facilityId} not found`);

  const periods = await CompliancePeriod.find().sort({ year: -1 }).session(session).lean();

  if (periods.length === 0) return [];

  // One aggregation over the whole period range, grouped by year. Cheaper than a
  // query per period, and the index on (facilityId, readingTs) serves it.
  const byYear = await EmissionReading.aggregate(
    [
      {
        $match: {
          facilityId: facility,
          readingTs: { $gte: periods[periods.length - 1].startDate, $lte: periods[0].endDate },
        },
      },
      { $group: { _id: { $year: '$readingTs' }, emitted: { $sum: '$co2Tonnes' } } },
    ],
    { session },
  ).exec();

  const emitted = new Map(byYear.map((r) => [r._id.year, r.emitted]));

  // The cap lives on the company, not the facility.
  const caps = await EmissionCap.aggregate(
    [
      { $match: { companyId: facilityDoc.companyId } },
      { $lookup: { from: 'complianceperiods', localField: 'periodId', foreignField: '_id', as: 'period' } },
      { $unwind: '$period' },
      { $project: { _id: 0, year: '$period.year', cap: '$capTonnes' } },
    ],
    { session },
  ).exec();
  const capByYear = new Map(caps.map((c) => [c.year, c.cap]));

  return periods.map((p) => ({
    year: p.year,
    emitted: emitted.get(p.year) ?? 0,
    cap: capByYear.get(p.year) ?? null,
  }));
}

/** Total audit rows matching a filter, for the pager. */
async function countAuditRows({ tableName = null, changedBy = null, session = null } = {}) {
  const filter = {};
  if (tableName) filter.tableName = tableName;
  if (changedBy) filter.changedBy = oid(changedBy, 'changedBy');
  return AuditLog.countDocuments(filter, { session });
}

/** Audit view for a single report: the report, its decision, and the actor. */
async function reportAudit(reportId, { session = null } = {}) {
  return Verification.aggregate(
    [
      { $match: { reportId: oid(reportId, 'reportId') } },
      lookup('verifiers', 'verifierId', 'verifier'),
      lookup('emissionreports', 'reportId', 'report'),
      lookup('companies', 'report.companyId', 'company'),
      { $unwind: { path: '$report', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          reportId: 1,
          decision: 1,
          remarks: 1,
          verifiedAt: 1,
          verifier: { $ifNull: [{ $first: '$verifier.name' }, null] },
          accreditationNo: { $ifNull: [{ $first: '$verifier.accreditationNo' }, null] },
          company: { $ifNull: [{ $first: '$company.name' }, null] },
          totalTonnes: { $ifNull: ['$report.totalTonnes', null] },
          status: { $ifNull: ['$report.status', null] },
        },
      },
    ],
    { session },
  ).exec();
}

module.exports = {
  oid,
  endExclusive,
  creditHoldings,
  facilityPeriodEmission,
  companyCompliance,
  verifyComplianceTotals,
  orderBook,
  sectorRank,
  rankSectors,
  monthlyEmission,
  periodTotals,
  tradeHistory,
  companiesWithBalances,
  auditTrail,
  countAuditRows,
  facilityEmissionByYear,
  reportAudit,
};
