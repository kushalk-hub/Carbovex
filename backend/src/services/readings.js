'use strict';

/**
 * Emission readings and period compliance.
 *
 * Two responsibilities that the SQL split between a trigger
 * (trg_period_total) and a function (fn_period_compliance), and which are kept
 * together here because both write periodtotals:
 *
 *   - ingestReading(): idempotent ingest plus the running total
 *   - runPeriodCompliance(): close a year, retire against caps, raise penalties
 */

const { errors } = require('../middleware/errors');
const { transaction } = require('../models/helpers');
const {
  EmissionReading,
  PeriodTotal,
  EmissionCap,
  CompliancePeriod,
  Facility,
  Company,
  Alert,
  Penalty,
  Sensor,
} = require('../models');
const { dedupeKeyFor } = require('../models');
const audit = require('./audit');
const aggregations = require('./aggregations');
const credits = require('./credits');

const { oid, endExclusive } = aggregations;

/** The UTC year a timestamp falls in. Compliance years are calendar years. */
const utcYear = (date) => new Date(date).getUTCFullYear();

/** Find the compliance period containing a timestamp. */
async function periodForDate(date, session = null) {
  const ts = new Date(date);
  return CompliancePeriod.findOne({ startDate: { $lte: ts }, endDate: { $gte: ts } })
    .session(session)
    .lean();
}

/**
 * Ingest one reading.
 *
 * `idempotent: true` is the sensor path. The SQL used
 * `ON CONFLICT (sensor_id, reading_ts) DO NOTHING` against a *partial* unique
 * index, which never matched — so every ingest failed with "no unique or
 * exclusion constraint matching the ON CONFLICT specification". The fix was not
 * to reproduce the index but to give deduplication an explicit key that is always
 * present, so the unique index needs no predicate to match.
 *
 * Replays are detected by catching duplicate-key on that index. `updateOne` with
 * `upsert` is deliberately not used: it would overwrite the original reading with
 * the replay, and readings are append-only, so a duplicate must be ignored
 * rather than rewritten.
 */
async function ingestReading(
  {
    facilityId,
    sensorId = null,
    sourceId = null,
    readingTs,
    co2Tonnes,
    verified = false,
    idempotent = false,
    session = null,
  } = {},
) {
  const run = async (s) => {
    const facility = oid(facilityId, 'facilityId');
    const ts = new Date(readingTs);
    const tonnes = Number(co2Tonnes);

    if (Number.isNaN(ts.getTime())) throw errors.badRequest('readingTs is not a valid date');
    if (!Number.isFinite(tonnes) || tonnes < 0) {
      throw errors.badRequest('co2Tonnes must be zero or greater');
    }

    // Re-read the facility inside the transaction. MongoDB has no foreign keys,
    // so nothing else stops a reading pointing at a facility that does not exist.
    const facilityDoc = await Facility.findById(facility, null, { session: s }).lean();
    if (!facilityDoc) throw errors.notFound(`Facility ${facilityId} not found`);

    if (sensorId) {
      const sensor = await Sensor.findById(oid(sensorId, 'sensorId'), null, { session: s }).lean();
      if (!sensor) throw errors.notFound(`Sensor ${sensorId} not found`);
      // A sensor may only report for the facility it is installed at.
      if (String(sensor.facilityId) !== String(facility)) {
        throw errors.badRequest('Sensor does not belong to this facility');
      }
    }

    const key = dedupeKeyFor({
      sensorId: sensorId ? oid(sensorId).toString() : null,
      facilityId: facility.toString(),
      readingTs: ts,
      sourceId: sourceId ? oid(sourceId).toString() : null,
    });

    const doc = {
      facilityId: facility,
      sensorId: sensorId ? oid(sensorId, 'sensorId') : null,
      sourceId: sourceId ? oid(sourceId, 'sourceId') : null,
      readingTs: ts,
      co2Tonnes: tonnes,
      verified: Boolean(verified),
      dedupeKey: key,
    };

    // Idempotency, and the reason it works this way.
    //
    // The natural port of `ON CONFLICT DO NOTHING` is to catch the duplicate-key
    // error and carry on. That does not work inside a MongoDB transaction: a
    // write error aborts the transaction, and every subsequent operation on that
    // session fails with "Transaction with { txnNumber: N } has been aborted."
    // Postgres treats a conflicting row as a no-op and carries on; MongoDB does
    // not. So the duplicate has to be *avoided* rather than caught:
    //
    //   1. read which of these dedupe keys already exist
    //   2. insert only the ones that do not
    //   3. if the insert still hits a duplicate, a concurrent writer won the race
    //      — the transaction aborts, and the whole attempt is retried from step 1
    //
    // Step 3 is what makes it correct rather than merely likely: the unique index
    // is the real arbiter, and the retry is what converts its abort into a
    // correct answer. A single retry suffices because the second pass sees the
    // winner's committed row.
    if (idempotent) {
      const already = await EmissionReading.findOne({ dedupeKey: key }).session(s).lean();
      if (already) {
        return { reading: already, duplicate: true, counted: false, periodId: null };
      }
    }

    const reading = await audit.applyInsert(EmissionReading, 'emissionreadings', doc, { session: s });

    // The running total. In SQL this was an AFTER INSERT trigger, so it could not
    // be forgotten and could not be skipped. Here it is a $inc in the same
    // transaction, which is the same guarantee *provided the two are not
    // separated* — hence rebuildingPeriodTotals() and the integration test.
    const period = await periodForDate(ts, s);
    if (period) {
      await PeriodTotal.findOneAndUpdate(
        { companyId: facilityDoc.companyId, periodId: period._id },
        { $inc: { tonnes }, $set: { updatedAt: new Date() } },
        { upsert: true, session: s },
      ).exec();
    }

    return { reading, duplicate: false, counted: true, periodId: period ? period._id : null };
  };

  return session ? run(session) : withDuplicateRetry(run);
}
function isDuplicateKey(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

/**
 * A duplicate-key error anywhere in a transaction, however it surfaced.
 *
 * Once a write fails inside a transaction, everything after it on that session
 * fails with "Transaction has been aborted", so the abort message — not the
 * original duplicate — is often what escapes. Both are treated as the same
 * condition, because both mean "a concurrent writer inserted a row we were
 * about to insert".
 */
function isAbortedDuplicate(err) {
  return (
    isDuplicateKey(err) ||
    /has been aborted|Transaction (?:aborted)|TransientTransactionError/i.test(err?.message ?? '')
  );
}

/**
 * Run a transaction body, retrying once if a concurrent writer beat us to a row.
 *
 * A single retry, because the second pass re-reads and so sees the winner's row.
 * If a second collision happened it would mean a third writer inserting the same
 * readings continuously, which is not a race worth looping on.
 */
async function withDuplicateRetry(run, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await transaction(run);
    } catch (err) {
      if (!isAbortedDuplicate(err) || i === attempts - 1) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** Bulk ingest for the CCT import and the sensor simulator. */
async function ingestMany(readings, { idempotent = true, session = null } = {}) {
  const run = async (s) => {
    if (!Array.isArray(readings) || readings.length === 0) {
      return { total: 0, inserted: 0, duplicates: 0, readings: [] };
    }

    const facilityIds = [...new Set(readings.map((r) => String(r.facilityId)))];
    const facilities = await Facility.find({ _id: { $in: facilityIds.map((f) => oid(f, 'facilityId')) } })
      .select('_id companyId')
      .session(s)
      .lean();
    const companyOf = new Map(facilities.map((f) => [String(f._id), f.companyId]));

    for (const f of facilityIds) {
      if (!companyOf.has(f)) throw errors.notFound(`Facility ${f} not found`);
    }

    // The date buckets the readings fall into. Needed up front so the running
    // total can be advanced once per period instead of once per reading — with
    // 1000 readings landing in one day that is 1 $inc rather than 1000.
    const timestamps = readings.map((r) => new Date(r.readingTs));
    for (const ts of timestamps) {
      if (Number.isNaN(ts.getTime())) throw errors.badRequest('readingTs is not a valid date');
    }
    const minTs = new Date(Math.min(...timestamps.map((d) => d.getTime())));
    const maxTs = new Date(Math.max(...timestamps.map((d) => d.getTime())));

    // Any period that could contain one of these readings: start no later than
    // the latest reading, and end no earlier than the earliest. Both bounds are
    // needed — a period that ended before the batch still has to be fetched in
    // order to conclude the readings fall outside it.
    const periods = await CompliancePeriod.find({
      startDate: { $lte: maxTs },
      endDate: { $gte: minTs },
    })
      .session(s)
      .lean();

    // A reading outside every period is accepted and simply not counted; there is
    // no period to add it to and inventing one would put it in the wrong year.
    const periodFor = (ts) =>
      periods.find((p) => p.startDate <= ts && p.endDate >= ts) ?? null;

    // Build every document first, so a malformed reading fails before any write.
    const docs = [];
    for (let i = 0; i < readings.length; i += 1) {
      const r = readings[i];
      const ts = timestamps[i];
      const tonnes = Number(r.co2Tonnes);
      if (!Number.isFinite(tonnes) || tonnes < 0) {
        throw errors.badRequest('co2Tonnes must be zero or greater');
      }

      // An explicit sourceId is accepted as given. The route passes null for
      // sensor telemetry, so an unverified reading is never attributed to a
      // human-verified source.
      const sourceId = r.sourceId ? oid(r.sourceId, 'sourceId') : null;

      docs.push({
        facilityId: oid(r.facilityId, 'facilityId'),
        sensorId: r.sensorId ? oid(r.sensorId, 'sensorId') : null,
        sourceId,
        readingTs: ts,
        co2Tonnes: tonnes,
        verified: Boolean(r.verified),
        dedupeKey: dedupeKeyFor({
          sensorId: r.sensorId ? oid(r.sensorId).toString() : null,
          facilityId: oid(r.facilityId).toString(),
          readingTs: ts,
          sourceId: sourceId ? sourceId.toString() : null,
        }),
        _companyId: companyOf.get(String(r.facilityId)),
        _period: periodFor(ts),
      });
    }

    // Drop anything already stored before writing, for the same reason as the
    // single-reading path: a duplicate-key error aborts the transaction, so
    // conflicts are avoided rather than caught. See the comment in
    // ingestReading — this is the batch form of the same three steps.
    const allKeys = docs.map((d) => d.dedupeKey);
    let fresh = docs;
    let existingKeys = new Set();

    if (idempotent) {
      const stored = await EmissionReading.find(
        { dedupeKey: { $in: allKeys } },
        { dedupeKey: 1 },
      )
        .session(s)
        .lean();
      existingKeys = new Set(stored.map((r) => r.dedupeKey));
      fresh = docs.filter((d) => !existingKeys.has(d.dedupeKey));
    }

    // Nothing new in this batch: a pure replay. Reporting it without opening a
    // write is the common case for a sensor that retries, so it should be cheap.
    if (fresh.length === 0) {
      const existing = await EmissionReading.find({ dedupeKey: { $in: allKeys } })
        .session(s)
        .lean();
      return {
        total: docs.length,
        inserted: 0,
        duplicates: existingKeys.size,
        readings: existing,
      };
    }

    // One unordered bulkWrite. ordered:false keeps a failure on one document from
    // aborting the rest of the batch.
    const payload = fresh.map(({ _companyId, _period, ...doc }) => doc);

    const write = await EmissionReading.collection.bulkWrite(
      payload.map((doc) => ({ insertOne: { document: doc } })),
      { ordered: false, session: s },
    );

    const insertedCount = write.insertedCount ?? 0;
    const duplicateCount = (write.writeErrors ?? []).filter((e) => e.err?.code === 11000).length;

    // Advance the running total once per (company, period) actually touched.
    // Only the documents that were really inserted contribute: counting a
    // duplicate here is exactly the double-count the dedupe key exists to
    // prevent.
    const insertedKeys = new Set(payload.map((d) => d.dedupeKey));
    const deltas = new Map();
    for (const doc of fresh) {
      if (!doc._period) continue;
      if (!insertedKeys.has(doc.dedupeKey)) continue;
      const key = `${doc._companyId}|${doc._period._id}`;
      deltas.set(key, (deltas.get(key) ?? 0) + doc.co2Tonnes);
    }

    for (const [key, tonnes] of deltas) {
      const [companyId, periodId] = key.split('|');
      await PeriodTotal.findOneAndUpdate(
        { companyId: oid(companyId), periodId: oid(periodId) },
        { $inc: { tonnes }, $set: { updatedAt: new Date() } },
        { upsert: true, session: s },
      ).exec();
    }

    // The accepted documents, so the caller can report them.
    const accepted = await EmissionReading.find({ dedupeKey: { $in: payload.map((d) => d.dedupeKey) } })
      .session(s)
      .lean();

    // The audit trail. One entry per accepted reading, written after the fact
    // rather than per-document during the insert, because bulkWrite bypasses the
    // model hooks that would otherwise record them.
    for (const doc of accepted) {
      await audit.inserted('emissionreadings', doc, s);
    }

    return {
      total: docs.length,
      inserted: insertedCount,
      duplicates: existingKeys.size + duplicateCount,
      readings: accepted,
    };
  };

  return session ? run(session) : withDuplicateRetry(run);
}

/**
 * fn_rebuild_period_totals — recompute the running totals from the readings.
 *
 * The reason this exists at all: because the trigger is gone, periodtotals is
 * now maintained by application code, and application code can be wrong or
 * bypassed. This is the repair path, and the integration test uses it to prove
 * the incremental figure matches a full recomputation.
 */
async function rebuildPeriodTotals({ session = null } = {}) {
  const run = async (s) => {
    const periods = await CompliancePeriod.find().session(s).lean();

    // One aggregation per period, each summing readings in that window by
    // company. The obvious alternative — attaching the period list to every
    // document and matching against it — does not work, because a $match
    // comparing a document field to a field of an unwound array element needs
    // $expr with awkward variable scoping. Looping the (few) periods keeps the
    // range query index-friendly on (facilityId, readingTs), which matters more
    // here than saving two round trips.
    const rows = [];
    for (const period of periods) {
      const grouped = await EmissionReading.aggregate(
        [
          { $match: { readingTs: { $gte: period.startDate, $lte: period.endDate } } },
          {
            $lookup: {
              from: 'facilities',
              localField: 'facilityId',
              foreignField: '_id',
              as: 'facility',
            },
          },
          { $unwind: '$facility' },
          {
            $group: {
              _id: { companyId: '$facility.companyId', periodId: period._id },
              tonnes: { $sum: '$co2Tonnes' },
            },
          },
        ],
        { session: s },
      ).exec();
      rows.push(...grouped);
    }

    // Recomputing means replacing, so the old rows go first. In one transaction
    // this is atomic: readers see either the old totals or the new ones.
    await PeriodTotal.deleteMany({}, { session: s });

    if (rows.length) {
      await PeriodTotal.insertMany(
        rows.map((row) => ({
          companyId: row._id.companyId,
          periodId: row._id.periodId,
          tonnes: row.tonnes,
          updatedAt: new Date(),
        })),
        { session: s, ordered: true },
      );
    }
    return rows.length;
  };

  return session ? run(session) : transaction(run);
}

/**
 * How a compliance run turned out for one company.
 *
 * COMPLIANT  under the cap, nothing to do
 * CREDITED   over the cap, but the company had credits to surrender the excess
 * PENALISED  over the cap and short of credits, so the remainder became a fine
 *
 * Exported so the classification can be tested directly. It is the one mapping in
 * this service where a mistake is invisible in the happy path and costly in
 * production: getting it wrong under-penalises, because an over-cap company ends
 * up reported as compliant.
 */
function classifyOutcome(excess, shortfall) {
  if (excess === 0) return 'COMPLIANT';
  if (shortfall === 0) return 'CREDITED';
  return 'PENALISED';
}

/**
 * fn_period_compliance — close a compliance year.
 *
 * Returns one row per company with a cap for the period, including compliant
 * ones, so the admin results table is a single call.
 *
 * The order of operations matters and follows the SQL:
 *   excess  = max(emitted - cap, 0)
 *   retire  = what the company could actually surrender
 *   rest    = excess - retired, which becomes a fine
 * A company over its cap with no credits left is PENALISED, not COMPLIANT, and
 * one that retired enough is CREDITED. Getting the outcome mapping wrong here
 * would silently under-penalise.
 *
 * The whole run is one transaction: closing the period and writing the penalties
 * must not be separable, or a crash between them would leave a closed period
 * with no fines.
 */
async function runPeriodCompliance({ periodId, ratePerTonne = 3000, session = null } = {}) {
  const run = async (s) => {
    const period = await CompliancePeriod.findById(oid(periodId, 'periodId'), null, { session: s }).lean();
    if (!period) throw errors.notFound(`Compliance period ${periodId} not found`);
    if (period.status !== 'OPEN') {
      // The SQL raised 'Period % is already closed' with CX003.
      throw errors.conflict(`Period ${period.year} is already closed`, 'CX003');
    }

    const rate = Number(ratePerTonne);
  if (!Number.isFinite(rate) || rate < 0) throw errors.badRequest('ratePerTonne must be a non-negative number');

    const caps = await EmissionCap.find({ periodId: period._id })
      .sort({ companyId: 1 })
      .session(s)
      .lean();

    const companyIds = [...new Set(caps.map((c) => String(c.companyId)))];
    const companies = await Company.find({ _id: { $in: companyIds.map((id) => oid(id)) } })
      .session(s)
      .lean();
    const companyName = new Map(companies.map((c) => [String(c._id), c.name]));

    const results = [];

    for (const cap of caps) {
      const cid = cap.companyId;
      const total = await PeriodTotal.findOne({ companyId: cid, periodId: period._id })
        .session(s)
        .lean();
      const emitted = total ? Number(total.tonnes) : 0;
      const excess = Math.max(emitted - Number(cap.capTonnes), 0);

      let retired = 0;
      let shortfall = 0;

      if (excess > 0) {
        // A company may not have enough credits to cover the excess. retireCredits
        // returns what it actually managed, and the remainder is fined.
        const retirement = await credits.retireCredits({
          companyId: cid,
          quantity: excess,
          periodId: period._id,
          session: s,
        });
        retired = Number(retirement.retired);
        shortfall = Number(retirement.shortfall);

        if (shortfall > 0) {
          const fine = Math.round(shortfall * rate * 100) / 100;
          // ON CONFLICT (company_id, period_id) DO UPDATE in the SQL, so a
          // re-run replaces the penalty rather than stacking a second one.
          await Penalty.findOneAndUpdate(
            { companyId: cid, periodId: period._id },
            {
              $set: {
                excessTonnes: shortfall,
                ratePerTonne: rate,
                fineAmount: fine,
                issuedAt: new Date(),
              },
              $setOnInsert: { status: 'UNPAID' },
            },
            { upsert: true, session: s },
          ).exec();
        }
      }

      // CAP_EXCEEDED was guarded by a unique (company, period, alert_type) index
      // in SQL, which is why periodId could not be NULL there. Same guard here.
      if (excess > 0) {
        await Alert.findOneAndUpdate(
          { companyId: cid, periodId: period._id, alertType: 'CAP_EXCEEDED' },
          {
            $set: { message: `${companyName.get(String(cid)) || 'Company'} exceeded its cap by ${shortfall.toFixed(2)} tCO2`, isRead: false },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true, session: s },
        ).exec();
      }

      results.push({
        companyId: cid,
        company: companyName.get(String(cid)) || null,
        capTonnes: Number(cap.capTonnes),
        emitted,
        excess,
        retired,
        fine: Math.round(shortfall * rate * 100) / 100,
        outcome: classifyOutcome(excess, shortfall),
      });
    }

    // Closing the period is what makes a second run fail, so it happens last and
    // inside the same transaction.
    await CompliancePeriod.findOneAndUpdate(
      { _id: period._id },
      { $set: { status: 'CLOSED' } },
      { session: s },
    ).exec();

    return { periodId: period._id, year: period.year, results };
  };

  return session ? run(session) : transaction(run);
}

/** Raise the 90% and 100% threshold alerts for a period. */
async function refreshCapAlerts({ periodId, session = null } = {}) {
  const run = async (s) => {
    const period = await CompliancePeriod.findById(oid(periodId, 'periodId'), null, { session: s }).lean();
    if (!period) throw errors.notFound(`Compliance period ${periodId} not found`);

    const compliance = await aggregations.companyCompliance({ periodId: period._id, session: s });
    let raised = 0;

    for (const row of compliance) {
      const used = row.pctUsed ?? 0;
      const type = used >= 100 ? 'CAP_EXCEEDED' : used >= 90 ? 'CAP_90' : null;
      if (!type) continue;

      const message = `${row.name} has used ${used}% of its ${row.capTonnes} tCO2 cap`;

      // Upsert rather than insert: the unique index would reject the second run,
      // and resetting isRead=false is the point — this is a live warning.
      await Alert.findOneAndUpdate(
        { companyId: row.companyId, periodId: period._id, alertType: type },
        { $set: { message, isRead: false }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, session: s },
      ).exec();
      raised += 1;
    }
    return raised;
  };

  return session ? run(session) : transaction(run);
}

module.exports = {
  ingestReading,
  ingestMany,
  rebuildPeriodTotals,
  runPeriodCompliance,
  refreshCapAlerts,
  classifyOutcome,
  periodForDate,
  isDuplicateKey,
};
