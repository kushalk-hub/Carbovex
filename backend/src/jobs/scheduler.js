'use strict';

/**
 * Job scheduler.
 *
 * Deliberately not a cron library: the project needs three jobs on daily and
 * hourly boundaries, and node-cron is another dependency with another set of
 * semantics to reason about. setTimeout chains keep the whole schedule
 * readable and let a job skip straight to its next slot after it runs, so a
 * slow job cannot stack up behind itself.
 */

const env = require('../config/env');
const daily = require('./dailyPrice');
const { expireCredits } = require('./expireCredits');
const { SensorSimulator } = require('./sensorSimulator');

const HOUR = 3_600_000;
const timers = new Set();

let simulator = null;

/** Track a timer so stop() can clear all of them. */
function every(ms, name, fn) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const startedAt = Date.now();
    try {
      await fn();
    } catch (err) {
      // A failed job must not kill the process, and must not stop the schedule.
      console.error(`[jobs] ${name} failed:`, err.message);
    }
    const elapsed = Date.now() - startedAt;
    // Fire on the next boundary, not immediately after: if the job took 4
    // minutes, the next run is still at the top of the hour.
    const delay = Math.max(1000, ms - elapsed);
    if (!stopped) {
      const t = setTimeout(tick, delay);
      t.unref?.();
      timers.add(t);
    }
  };

  const t = setTimeout(tick, ms);
  t.unref?.();
  timers.add(t);
  console.log(`[jobs] ${name}: every ${Math.round(ms / 1000)}s`);
}

/** Run the nightly job now, so a fresh database is usable immediately. */
async function bootstrap() {
  if (env.isTest) return;
  try {
    await daily.refreshPriceHistory(new Date(Date.now() - 86_400_000));
    console.log('[jobs] bootstrap complete');
  } catch (err) {
    console.error('[jobs] bootstrap failed (non-fatal):', err.message);
  }
}

function start() {
  if (env.isTest) return;

  // 00:15 daily: rollups.
  every(24 * HOUR, 'daily rollup', () => daily.runDaily());
  // Every 6 hours: expiry sweep.
  every(6 * HOUR, 'credit expiry', () => expireCredits());

  bootstrap();

  // The simulator is opt-in via SIMULATE=true, so a normal `npm start` does not
  // quietly invent emissions and make the compliance numbers move on their own.
  if (String(process.env.SIMULATE).toLowerCase() === 'true') {
    simulator = new SensorSimulator().start();
  }
}

function stop() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  if (simulator) simulator.stop();
  simulator = null;
}

module.exports = { start, stop, every, bootstrap };
