'use strict';

/**
 * Sensor simulator.
 *
 * Exists as a library so the CLI (`npm run simulate`) and the tests can drive
 * the same code. It calls the public HTTP ingest endpoint rather than writing
 * to the database, so the demo exercises the real authentication, validation,
 * rate limiting and trigger path — a simulator that inserts rows directly would
 * prove nothing about the API.
 *
 * The one thing it deliberately does not fake: it never overwrites a timestamp
 * that already exists, so the idempotency guarantee is what stops duplicates
 * when the same tick is retried.
 */

const env = require('../config/env');
const { Sensor, Facility, Company } = require('../models');

/** A deterministic-ish jittered daily rate, in the shape sensors actually send. */
function dailyTonnes(baseline, rng = Math.random) {
  const seasonal = 1 + 0.06 * Math.sin((Date.now() / 86_400_000 / 58) * Math.PI);
  return Math.max(0.01, (baseline / 365) * (0.85 + rng() * 0.3) * seasonal);
}

class SensorSimulator {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl       e.g. http://localhost:4000
   * @param {string} opts.sensorKey     the shared demo key
   * @param {number} [opts.sensorsPerTick]
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.stepDays]    how many days of emission per tick
   * @param {boolean} [opts.dryRun]     compute and log, do not POST
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || `http://localhost:${env.port}`).replace(/\/$/, '');
    this.sensorKey = opts.sensorKey || env.sensorKey;
    this.sensorsPerTick = opts.sensorsPerTick ?? 5;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.stepDays = opts.stepDays ?? 1;
    this.dryRun = opts.dryRun ?? false;
    this.log = opts.log ?? ((...a) => console.log('[simulate]', ...a));

    this.timer = null;
    this.stats = { ticks: 0, inserted: 0, duplicates: 0, errors: 0 };
  }

  /**
   * Pick a handful of ONLINE sensors that have a known baseline, so the emitted
   * numbers are plausible rather than random noise.
   */
  async pickSensors() {
    const rows = await Sensor.aggregate([
      { $match: { status: 'ONLINE' } },
      { $sample: { size: this.sensorsPerTick } },
      { $lookup: { from: Facility.collection.name, localField: 'facilityId', foreignField: '_id', as: 'facility' } },
      { $unwind: '$facility' },
      { $lookup: { from: Company.collection.name, localField: 'facility.companyId', foreignField: '_id', as: 'company' } },
      { $unwind: '$company' },
      { $project: {
        sensorId: { $toString: '$_id' },
        facilityId: { $toString: '$facility._id' },
        baseline: '$facility.baselineAnnualTonnes',
        company: '$company.name',
      } },
    ]).exec();
    return rows;
  }

  /** Build the payload for one tick. */
  buildBatch(sensors, now = new Date()) {
    return sensors.map((s) => ({
      sensorId: s.sensorId,
      readings: Array.from({ length: this.stepDays }, (_, i) => ({
        // Each tick advances by a whole day, so a few minutes of demo time
        // visibly moves the compliance numbers.
        ts: new Date(now.getTime() - (this.stepDays - 1 - i) * 86_400_000).toISOString(),
        tonnes: Number(dailyTonnes(s.baseline).toFixed(3)),
        verified: false,
      })),
    }));
  }

  async tick() {
    this.stats.ticks += 1;
    let sensors;
    try {
      sensors = await pickSensorsSafe(this);
    } catch (err) {
      this.stats.errors += 1;
      this.log(`could not read sensors: ${err.message}`);
      return;
    }

    if (sensors.length === 0) {
      this.log('no ONLINE sensors found — run `npm run db:seed` first');
      return;
    }

    const now = new Date();
    const batches = this.buildBatch(sensors, now);

    if (this.dryRun) {
      const total = batches.flatMap((b) => b.readings).reduce((s, r) => s + r.tonnes, 0);
      this.log(
        `dry run: ${batches.length} sensor(s), ` +
          `${total.toFixed(1)} tCO2 (${sensors[0].company} +${batches.length - 1} more)`,
      );
      return;
    }

    // One request per sensor, sequentially: this is a simulator, and a burst of
    // 50 parallel POSTs would test the rate limiter rather than the pipeline.
    for (const batch of batches) {
      try {
        const res = await fetch(`${this.baseUrl}/api/readings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.sensorKey },
          body: JSON.stringify(batch),
        });

        if (res.status === 429) {
          this.log('rate limited, waiting for the next tick');
          return;
        }
        if (!res.ok) {
          this.stats.errors += 1;
          this.log(`HTTP ${res.status} for sensor ${batch.sensorId}: ${(await res.text()).slice(0, 200)}`);
          continue;
        }

        const body = await res.json();
        this.stats.inserted += body.inserted;
        this.stats.duplicates += body.duplicates;
        this.log(
          `+${body.inserted} new, ${body.duplicates} duplicate ` +
            `(facility ${body.facilityId}, ${sensors.find((s) => s.sensorId === batch.sensorId)?.company ?? ''})`,
        );
      } catch (err) {
        this.stats.errors += 1;
        this.log(`request failed: ${err.message}`);
      }
    }
  }

  start() {
    if (this.timer) return this;
    this.log(
      `starting: ${this.sensorsPerTick} sensor(s) every ${this.intervalMs / 1000}s, ` +
        `${this.stepDays} day(s) per tick -> ${this.baseUrl}/api/readings`,
    );
    // Fire immediately so the first output is immediate, then on the interval.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log(
      `stopped after ${this.stats.ticks} ticks: ` +
        `${this.stats.inserted} inserted, ${this.stats.duplicates} duplicate, ` +
        `${this.stats.errors} errors`,
    );
    return this;
  }
}

async function pickSensorsSafe(sim) {
  return sim.pickSensors();
}

module.exports = { SensorSimulator, dailyTonnes };
