'use strict';

/**
 * Start a single-node MongoDB replica set for local development and tests.
 *
 *   npm run mongo:test-rs        start it (idempotent)
 *   npm run mongo:test-rs -- stop
 *
 * Why this exists, and why it does not just use the mongod you already have:
 *
 * A standalone mongod cannot run multi-document transactions or change streams,
 * and the failure modes are bad:
 *
 *   transactions  fail outright: "Transaction numbers are only allowed on a
 *                 replica set member or mongos". Loud, and fine.
 *   change streams fail *silently*. `collection.watch()` returns a stream object
 *                 and raises nothing; it just never delivers an event, because the
 *                 $changeStream stage is rejected when the cursor is first used.
 *                 Verified on 9.0.2 — no error, no events, indefinitely.
 *
 * A single node is a real replica set, so both work, which is all the application
 * needs. A production deployment still wants three or five nodes: a single-node
 * set has no redundancy, and a failover loses the data along with availability.
 *
 * This deliberately uses a separate port and data directory from any existing
 * MongoDB service, so it cannot disturb a real installation. If you already run a
 * replica set on 27017, just point MONGO_URI at that instead and skip this.
 *
 * It starts mongod with --auth, which is not optional here. See the comment on the
 * spawn below: without it the least-privilege grants are not enforced, and the
 * append-only guarantee this project relies on would be worth nothing.
 *
 * What it does NOT do: create the application user. That is scripts/setup.js's job.
 * This gets far enough that the integration suite can run and that setup.js can
 * apply the real permissions.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.CARBONX_TEST_RS_PORT || 27018);
const REPL_SET = 'carbonx_rs0';
const SET_NAME = 'rs0';
const DATA_DIR = process.env.CARBONX_TEST_RS_DIR || path.join(os.tmpdir(), 'carbonx-rs0');
const LOG_FILE = path.join(DATA_DIR, 'mongod.log');
const KEY_FILE = path.join(DATA_DIR, 'replset.key');

/**
 * The shared secret the replica set members use to authenticate to each other.
 *
 * Required, not optional: a replica set started with authorization enabled must
 * also have a keyfile, or mongod refuses to start —
 *
 *   BadValue: security.keyFile is required when authorization is enabled with
 *   replica sets
 *
 * So a single-node test replica set needs member auth even though there is only
 * one member. The key is generated locally and lives only in the throwaway data
 * directory; there is nothing to protect here and no key to distribute.
 */
function ensureKeyFile() {
  if (fs.existsSync(KEY_FILE)) return KEY_FILE;
  const secret = crypto.randomBytes(756).toString('base64'); // 1008 chars, within the 6..1024 limit
  fs.writeFileSync(KEY_FILE, secret, { mode: 0o600 });
  return KEY_FILE;
}

/** Locate mongod. Checked in the order a developer is most likely to have it. */
function findMongod() {
  const candidates = [];

  if (process.env.MONGOD_PATH) candidates.push(process.env.MONGOD_PATH);

  // Version-suffixed install directories, newest first.
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const root of programFiles) {
    const serverDir = path.join(root, 'MongoDB', 'Server');
    if (!fs.existsSync(serverDir)) continue;
    const versions = fs
      .readdirSync(serverDir)
      .filter((v) => /^\d+\.\d+/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) candidates.push(path.join(serverDir, v, 'bin', 'mongod.exe'));
    for (const v of versions) candidates.push(path.join(serverDir, v, 'bin', 'mongod'));
  }

  candidates.push('mongod'); // last resort: rely on PATH

  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
      });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return null;
}

/** Locate mongosh, for rs.initiate(). The old `mongo` shell is gone in modern releases. */
function findMongosh() {
  if (process.env.MONGOSH_PATH) return process.env.MONGOSH_PATH;
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'mongosh', 'mongosh.exe');
  if (fs.existsSync(local)) return local;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mongosh'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  return null;
}

/**
 * True when something is already listening on the port.
 *
 * A plain TCP connect rather than Test-NetConnection or nc: PowerShell's version
 * takes several seconds per call, and this runs in a polling loop, so a slow probe
 * made startup look like a 30-second hang. This resolves in milliseconds.
 */
function portInUse(port, timeoutMs = 500) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

function runMongosh(args) {
  const mongosh = findMongosh();
  if (!mongosh) return { ok: false, error: 'mongosh not found' };
  const res = spawnSync(mongosh, ['--quiet', '--port', String(PORT), ...args], { encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function main() {
  const stop = process.argv.includes('stop');

  if (stop) {
    const res = runMongosh(['--eval', 'db.getSiblingDB("admin").shutdownServer({force:true})']);
    if (res.ok) console.log('[mongo] shut down');
    else console.log('[mongo] nothing to shut down, or already stopped');
    return;
  }

  const mongod = findMongod();
  if (!mongod) {
    console.error(
      '[mongo] could not find mongod.\n' +
        '        Install MongoDB, or set MONGOD_PATH to the binary.',
    );
    process.exit(1);
  }

  // Already up? Initiate if needed and stop there, so the script is idempotent.
  if (await portInUse(PORT)) {
    console.log(`[mongo] something is already listening on ${PORT}`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const keyFile = ensureKeyFile();
    const child = spawn(
      mongod,
      [
        '--replSet', SET_NAME,
        '--port', String(PORT),
        '--dbpath', DATA_DIR,
        '--bind_ip', '127.0.0.1',
        // --keyFile is what turns authorization on, and it cannot be used without
        // --replSet. The reason this matters is not obvious and was measured on
        // this exact setup: a mongod started WITHOUT it still performs
        // authentication — a wrong password is still rejected — but it does not
        // enforce authorization. A user whose role grants nothing can insert and
        // read everything. The least-privilege grants that enforce the
        // append-only guarantee would therefore be silently inert.
        //
        // getCmdLineOpts does not show this, because authorization is on by
        // default from MongoDB 6.0, so its absence from that output means nothing
        // either way. The only reliable check is to try a denied operation.
        '--keyFile', keyFile,
        '--logpath', LOG_FILE,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    console.log(`[mongo] started mongod on ${PORT} (dbpath ${DATA_DIR})`);

    // Wait for it to accept connections before initiating.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await portInUse(PORT))) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!(await portInUse(PORT))) {
      console.error(`[mongo] mongod did not start within 30s. See ${LOG_FILE}`);
      process.exit(1);
    }
  }

  // rs.initiate only succeeds once; a second call reports AlreadyInitialized,
  // which is fine and is why this is attempted unconditionally.
  const initiated = runMongosh([
    '--eval',
    `try { rs.initiate({_id:'${SET_NAME}',members:[{_id:0,host:'127.0.0.1:${PORT}'}]}); } catch (e) { print(e.codeName || e.message); }`,
  ]);
  if (!initiated.ok) {
    console.error('[mongo] could not run rs.initiate:', initiated.error || initiated.stderr.trim());
    process.exit(1);
  }

  // Wait for a primary, or a replica set is initiated but not yet usable.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    const check = runMongosh(['--eval', 'print(db.hello().isWritablePrimary === true)']);
    if (check.stdout.includes('true')) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    console.error('[mongo] the replica set did not elect a primary within 30s');
    process.exit(1);
  }

  console.log(`[mongo] replica set '${SET_NAME}' is ready on port ${PORT}`);
  console.log('');
  console.log('  Run the tests against it:');
  console.log(`    $env:MONGO_URI = "mongodb://localhost:${PORT}/carbonx_test?replicaSet=${SET_NAME}"`);
  console.log('    npm run test:db');
  console.log('');
  console.log('  Or set it permanently for this shell session.');
}

main().catch((err) => {
  console.error('[mongo] failed:', err.message);
  process.exit(1);
});
