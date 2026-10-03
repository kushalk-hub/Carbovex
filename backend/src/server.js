'use strict';

/**
 * Process entry point.
 *
 * Responsibilities, in order:
 *   1. fail fast if the database is not reachable
 *   2. start the HTTP server
 *   3. start realtime (socket + LISTEN)
 *   4. start background jobs
 *   5. shut all of it down cleanly on SIGINT/SIGTERM
 */

const http = require('http');
const env = require('./config/env');
const db = require('./db/connect');
const { createApp } = require('./app');
const realtime = require('./realtime');
const jobs = require('./jobs/scheduler');

let server = null;
let shuttingDown = false;

async function start() {
  // 1. Database first. Booting an API that cannot reach its database just
  //    produces a stream of 500s that look like an application bug.
  try {
    await db.connect();
    if (!(await db.supportsTransactions())) {
      console.error('[db] This server cannot run multi-document transactions.');
      console.error('[db] Run `npm run mongo:test-rs` for a local replica set.');
      process.exit(1);
    }
    console.log(`[db] ready: ${env.db.appDatabase}`);
  } catch (err) {
    console.error(`[db] ${err.message}`);
    process.exit(1);
  }

  const app = createApp();
  server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.port, resolve);
  });

  console.log(`[http] CarbonX API listening on http://localhost:${env.port} (${env.NODE_ENV})`);
  console.log(`[http] CORS allows: ${env.corsOrigin.join(', ')}`);

  // 3. Realtime is best-effort: never block the boot on it.
  await realtime.initRealtime(server);

  // 4. Jobs.
  jobs.start();

  return server;
}

/**
 * Graceful shutdown.
 *
 * Stop accepting connections, let in-flight requests finish, then close the
 * connection. Without the timer there is no upper bound on how long a long-lived
 * SSE or websocket client can hold the process open.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, closing gracefully`);

  const force = setTimeout(() => {
    console.error('[shutdown] took too long, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    jobs.stop();
    await realtime.stopRealtime();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[shutdown] http server closed');
    }
    await db.close();
    console.log('[shutdown] database connection closed');
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] failed:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// An unhandled rejection means a promise was left floating — almost always a
// fire-and-forget write. Log it loudly rather than letting Node 20+ kill the
// process, and let the process keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  shutdown('uncaughtException');
});

if (require.main === module) {
  start().catch((err) => {
    console.error('[fatal] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { start, shutdown };
