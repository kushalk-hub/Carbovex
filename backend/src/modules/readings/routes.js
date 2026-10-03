'use strict';

/**
 * POST /api/readings   sensor ingest (API key, not JWT)
 *
 * This is the highest-volume endpoint in the system: one request can carry
 * 1000 readings, and every accepted row fires two triggers. The design
 * priorities, in order, are:
 *
 *   1. Idempotency.  A sensor that retries after a timeout must not double
 *      count. The unique index on (sensor_id, reading_ts) plus ON CONFLICT DO
 *      NOTHING makes the same batch safe to send any number of times.
 *   2. Honest reporting. Duplicates are *counted and returned*, not silently
 *      swallowed — a sensor that is stuck sending stale data should be able to
 *      see that.
 *   3. Bounded work. Rate limited separately from the rest of the API.
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas } = require('../../middleware/validate');
const { ingestLimiter } = require('../../middleware/rateLimit');
const { hashSensorKey, safeEqualHex } = require('../../middleware/auth');
const { Sensor, EmissionReading } = require('../../models');
const { readings: readingService } = require('../../services');
const realtime = require('../../realtime');

const router = express.Router();

/**
 * Look up a sensor by its API key, or null.
 *
 * The hash is a plain sha256 rather than bcrypt, deliberately. This path matches
 * a key on every single ingest request — the highest-volume endpoint in the
 * system — and bcrypt is built to be slow. The key is high-entropy and
 * machine-generated, so there is nothing to brute-force; what protects it is
 * that it is never stored in plaintext and never leaves the sensor.
 */
async function sensorForKey(plainKey, sensorId) {
  if (!plainKey) return null;
  const presented = hashSensorKey(plainKey);
  // Ingest includes a sensor ID, so match both it and the key. Demo sensors
  // intentionally share one key; a hash-only lookup can select a different
  // sensor nondeterministically. The read-only recent endpoint has no body ID,
  // so it uses the key alone and resolves one of the matching demo sensors.
  return Sensor.findOne({ ...(sensorId ? { _id: sensorId } : {}), apiKeyHash: presented }).lean();
}

/** Middleware: authenticate the sensor, attach req.sensor. */
async function requireSensorKey(req, res, next) {
  try {
    const header = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer /i, '');
    const key = Array.isArray(header) ? header[0] : header;

    const sensor = await sensorForKey(key, req.body?.sensorId);
    if (!sensor || !safeEqualHex(sensor.apiKeyHash, hashSensorKey(key))) {
      return next(errors.unauthorized('Invalid or missing sensor API key'));
    }
    if (sensor.status !== 'ONLINE') {
      return next(errors.forbidden(`Sensor is ${sensor.status}`));
    }

    req.sensor = sensor;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/readings
 *
 * Body: { sensorId, readings: [{ ts, tonnes, verified? }] }
 * 201:  { inserted, duplicates, readings: [...] }
 */
router.post(
  '/',
  ingestLimiter,
  validate(schemas.ingest),
  requireSensorKey,
  async (req, res, next) => {
    try {
      const { sensorId, readings } = req.body;

      // A key may only write as the sensor it belongs to. Without this, any
      // valid key could inject readings for any facility. Compared as strings:
      // both are ObjectIds, and numeric coercion would make them NaN.
      if (String(sensorId) !== String(req.sensor._id)) {
        return next(errors.forbidden('sensorId does not match the authenticated sensor'));
      }

      // Reject readings from the future: they would never be correctable and
      // they distort every cap calculation immediately.
      const now = Date.now();
      const future = readings.find((r) => r.ts.getTime() > now + 5 * 60_000);
      if (future) {
        return next(errors.unprocessable(`Reading timestamp ${future.ts.toISOString()} is in the future`));
      }

      // De-duplicate inside the request first, so one bad batch does not
      // report the same reading as a "duplicate" of itself.
      const unique = new Map();
      let inBatchDuplicates = 0;
      for (const r of readings) {
        const key = r.ts.toISOString();
        if (unique.has(key)) inBatchDuplicates += 1;
        else unique.set(key, r);
      }

      const batch = [...unique.values()].map((r) => ({
        facilityId: String(req.sensor.facilityId),
        sensorId: String(req.sensor._id),
        readingTs: r.ts,
        co2Tonnes: r.tonnes,
        verified: r.verified ?? false,
        // sourceId stays null: this is machine-reported, unverified telemetry,
        // and attributing it to a human-verified source would let it count
        // towards a compliance cap.
        sourceId: null,
      }));

      // One transaction for the whole batch, written in a single bulk insert.
      //
      // The SQL used INSERT ... SELECT unnest(...) ON CONFLICT DO NOTHING, which
      // is one round trip and lets the server skip conflicts. MongoDB has no
      // single-statement upsert-many-with-skip, so the batch is done as:
      //   1. one bulkWrite of inserts with ordered:false, so a duplicate key on
      //      one document does not abort the rest;
      //   2. the service updates periodtotals once per period, not per reading.
      //
      // Step 2 is why ingestMany exists rather than a naive loop: 1000 readings
      // would otherwise be 1000 $inc round trips against the same handful of
      // periodtotal documents, which is the difference between ~50ms and
      // ~30 seconds.
      const result = await readingService.ingestMany(batch, { idempotent: true });

      // last_seen_at is telemetry about the sensor, not part of the emission
      // record, so it is not transactional with the readings. Failing to update
      // it must not fail an accepted batch.
      Sensor.updateOne({ _id: req.sensor._id }, { $set: { lastSeenAt: new Date() } })
        .catch((err) => console.error('[readings] lastSeenAt update failed:', err.message));

      // Push to the globe. Fire and forget: a slow websocket must never delay a
      // 201 to a sensor that is on a metered connection. The change stream also
      // announces these, and the shared event id deduplicates them.
      for (const r of result.readings ?? []) {
        realtime.emitReading(String(req.sensor.facilityId), {
          facilityId: String(req.sensor.facilityId),
          sensorId: String(req.sensor._id),
          ts: r.readingTs,
          tonnes: r.co2Tonnes,
          verified: r.verified,
        });
      }

      res.status(201).json({
        inserted: result.inserted,
        // Includes both replays of already-stored readings and repeats within
        // this batch. A sensor stuck sending stale data can see it here.
        duplicates: result.duplicates + inBatchDuplicates,
        facilityId: String(req.sensor.facilityId),
        readings: (result.readings ?? []).map((r) => ({
          ts: r.readingTs,
          tonnes: r.co2Tonnes,
          verified: r.verified,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/readings/recent
 *
 * Debug helper for the simulator: the last few readings for a sensor, so you
 * can confirm a batch landed without opening psql.
 */
router.get(
  '/recent',
  requireSensorKey,
  async (req, res, next) => {
    try {
      const rows = await EmissionReading.find({ sensorId: req.sensor._id })
        .sort({ readingTs: -1 })
        .limit(20)
        .lean();
      res.json({
        sensorId: String(req.sensor._id),
        readings: rows.map((r) => ({
          ts: r.readingTs,
          tonnes: r.co2Tonnes,
          verified: r.verified,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = { router, requireSensorKey, sensorForKey };
