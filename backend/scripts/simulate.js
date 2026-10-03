'use strict';

/**
 * Sensor simulator CLI.
 *
 *   npm run simulate
 *   npm run simulate -- --sensors 10 --interval 2000 --days 1
 *   npm run simulate -- --dry-run
 *   npm run simulate -- --once
 *
 * Requires the API to be running (`npm start` in another terminal), because
 * this posts to the real HTTP endpoint rather than inserting rows directly.
 */

const { SensorSimulator } = require('../src/jobs/sensorSimulator');
const env = require('../src/config/env');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'once') {
      out[key] = true;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[key] = argv[i + 1];
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function num(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!env.sensorKey && !args['sensor-key']) {
    console.error('[simulate] SENSOR_KEY is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const sim = new SensorSimulator({
    baseUrl: args.url || `http://localhost:${env.port}`,
    sensorKey: args['sensor-key'] || env.sensorKey,
    sensorsPerTick: num(args.sensors, 5),
    intervalMs: num(args.interval, 3000),
    stepDays: num(args.days, 1),
    dryRun: Boolean(args['dry-run']),
  });

  // Confirm the API is up before the first tick, so a wrong port produces one
  // clear message instead of a repeating error every few seconds.
  if (!args['dry-run']) {
    try {
      const res = await fetch(`${sim.baseUrl}/health`);
      if (!res.ok) throw new Error(`health returned ${res.status}`);
      const body = await res.json();
      console.log(`[simulate] API is up (${body.status}, database ${body.database})`);
      if (body.database !== 'up') {
        console.error('[simulate] the API is running but cannot reach the database');
        process.exit(1);
      }
    } catch (err) {
      console.error(`[simulate] cannot reach the API at ${sim.baseUrl}: ${err.message}`);
      console.error('[simulate] start it first:  npm start');
      process.exit(1);
    }
  }

  if (args.once) {
    await sim.tick();
    console.log('[simulate] single tick done:', sim.stats);
    process.exit(0);
  }

  sim.start();
  console.log('[simulate] press Ctrl+C to stop');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      sim.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[simulate] failed:', err.message);
  process.exit(1);
});
