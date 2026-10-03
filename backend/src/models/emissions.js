'use strict';

/**
 * Emissions: readings, the incremental period totals, caps, and alerts.
 *
 * The interesting part is EmissionReading.dedupeKey, so read that comment before
 * changing anything here.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, nowDate, appendOnly } = require('./helpers');

/**
 * Incremental per-company, per-period totals.
 *
 * This collection is the reason the compliance views are cheap. Recomputing
 * emissions from the reading history on every request is a full scan; keeping a
 * running total means the read is a single indexed lookup.
 *
 * That makes correctness load-bearing, and in PostgreSQL it was enforced by a
 * trigger that could not be bypassed. Here it is maintained by
 * services/readings.js inside the same transaction that writes the reading. If
 * that code path is ever bypassed, this collection silently goes stale — so
 * `rebuildPeriodTotals()` exists, is idempotent, and is checked against a full
 * recomputation by the integration test.
 */
const PeriodTotal = mongoose.model(
  'PeriodTotal',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod', { required: true }), required: true },
      tonnes: { ...nonNegative, default: 0 },
      updatedAt: nowDate,
    },
    { ...base, collection: 'periodtotals' },
  ),
);
PeriodTotal.schema.index({ companyId: 1, periodId: 1 }, { unique: true });

/**
 * A single emission reading.
 *
 * Append-only: readings are never edited. A correction is a new reading, and
 * the immutable-data story is part of what this system is for.
 */
const EmissionReadingSchema = appendOnly(
  new mongoose.Schema(
    {
      facilityId: { ...ref('Facility', { required: true }), required: true },
      sensorId: { ...ref('Sensor'), default: null },
      sourceId: { ...ref('EmissionSource'), default: null },

      readingTs: { type: Date, required: true },
      co2Tonnes: { ...nonNegative, required: true },
      verified: { type: Boolean, required: true, default: false },

      /**
       * Idempotency key, always present, always unique.
       *
       * The PostgreSQL version used a UNIQUE index on (sensor_id, reading_ts)
       * and `ON CONFLICT DO NOTHING`. It was written as a *partial* index
       * (`WHERE sensor_id IS NOT NULL`) so that manual readings without a
       * sensor would not collide — and that broke every single ingest, because
       * an upsert only uses a partial index when the filter reproduces the
       * index predicate. Every request failed with "no unique or exclusion
       * constraint matching the ON CONFLICT specification".
       *
       * MongoDB has the same trap waiting: a unique index treats a missing
       * field as a value equal to every other missing field, so a plain
       * `unique: true` on sensorId would make the *second* manual reading fail.
       * Using a partial index here would just relocate the trap.
       *
       * So the deduplication is done by an explicit key that is never null and
       * never partial:
       *
       *   sensor reading  s:<sensorId>:<ISO timestamp>
       *   manual reading  m:<facilityId>:<ISO timestamp>:<sourceId|none>
       *
       * A plain unique index on that string has no predicate to reproduce, so
       * the idempotent upsert cannot fail for structural reasons. A manual
       * reading at the same instant for the same facility and source is a
       * genuine duplicate and is rejected, which is the behaviour we wanted
       * from the partial index in the first place.
       */
      dedupeKey: { type: String, required: true, unique: true },
    },
    { ...base, collection: 'emissionreadings' },
  ),
  'emissionreadings',
);
const EmissionReading = mongoose.model('EmissionReading', EmissionReadingSchema);

// The one query that matters most: all readings for a facility in a date range,
// for the chart and the period totals. Matches (facilityId, readingTs) range.
EmissionReading.schema.index({ facilityId: 1, readingTs: 1 });
EmissionReading.schema.index({ readingTs: 1 });
EmissionReading.schema.index({ sensorId: 1, readingTs: 1 });

/** Build the dedupe key for a reading. Exported so ingest and tests agree. */
function dedupeKeyFor({ sensorId, facilityId, readingTs, sourceId }) {
  const ts = new Date(readingTs).toISOString();
  if (sensorId) return `s:${sensorId}:${ts}`;
  return `m:${facilityId}:${ts}:${sourceId ?? 'none'}`;
}

/**
 * Caps, one per company per period.
 *
 * Capped in Postgres, so this is a unique compound index instead. Note it is
 * the *only* thing preventing a duplicate cap row: nothing else checks.
 */
const EmissionCap = mongoose.model(
  'EmissionCap',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod', { required: true }), required: true },
      capTonnes: { type: Number, required: true, min: Number.MIN_VALUE },
    },
    { ...base, collection: 'emissioncaps' },
  ),
);
EmissionCap.schema.index({ companyId: 1, periodId: 1 }, { unique: true });

/**
 * Alerts.
 *
 * periodId is NOT NULL, and that matters. The SQL version had a nullable
 * period_id with UNIQUE (company_id, period_id, alert_type) — and since NULLs
 * compare distinct, a nullable period would have let the same cap alert be
 * inserted twice, defeating the constraint entirely. Non-null is the fix, not a
 * cosmetic choice.
 */
const Alert = mongoose.model(
  'Alert',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod', { required: true }), required: true },
      alertType: {
        type: String,
        required: true,
        enum: ['CAP_90', 'CAP_EXCEEDED', 'SENSOR_OFFLINE', 'LOW_BALANCE'],
      },
      message: { type: String, required: true },
      isRead: { type: Boolean, required: true, default: false },
      createdAt: nowDate,
    },
    { ...base, collection: 'alerts' },
  ),
);
Alert.schema.index({ companyId: 1, periodId: 1, alertType: 1 }, { unique: true });
Alert.schema.index({ companyId: 1, isRead: 1 });
Alert.schema.index({ createdAt: -1 });

module.exports = { PeriodTotal, EmissionReading, EmissionCap, Alert, dedupeKeyFor };
