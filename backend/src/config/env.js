'use strict';

/**
 * Central environment loading and validation.
 *
 * Every other module imports `env` from here and never touches process.env
 * directly, so a missing or dangerous value fails once at boot with a readable
 * message instead of surfacing as a confusing 500 three hours later.
 */

const path = require('path');
const fs = require('fs');

// dotenv is optional at runtime: in production the values usually come from the
// platform's secret store, and on a dev machine .env is often absent.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch {
  /* dotenv not installed, or no .env file — fall back to the real environment */
}

const DEV_SECRET = 'dev-only-change-me-0123456789abcdef';

function str(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }
  return v;
}

function int(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got "${v}"`);
  return n;
}

const NODE_ENV = str('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const jwtSecret = str('JWT_SECRET', isProduction ? undefined : DEV_SECRET);
if (isProduction && jwtSecret === DEV_SECRET) {
  throw new Error('JWT_SECRET is still the example value. Set a real secret before running in production.');
}

/**
 * Connection settings.
 *
 * `uri` is the single source of truth — the individual fields below exist only
 * to build it, so that a deployment can set either MONGO_URI or the discrete
 * parts without the code having to care which.
 *
 * `appUser`/`appPassword` exist to support the append-only guarantee: setup.js
 * creates a least-privilege database user that can insert into the ledger but
 * not update or delete it, which is the MongoDB equivalent of the REVOKE the
 * PostgreSQL version relied on. See legacy-postgres/README.md.
 */
const db = {
  uri: str(
    'MONGO_URI',
    `mongodb://${str('DB_USER', 'carbonx_app')}:${str('DB_PASSWORD', 'carbonx_app')}` +
      `@${str('DB_HOST', 'localhost')}:${int('DB_PORT', 27017)}/${str('DB_NAME', 'carbonx')}` +
      '?authSource=admin',
  ),
  appDatabase: str('DB_NAME', 'carbonx'),
  appUser: str('DB_USER', 'carbonx_app'),
  appPassword: str('DB_PASSWORD', 'carbonx_app'),
  // Used by scripts/setup.js to create the database, the role and the indexes.
  adminUri: str(
    'MONGO_ADMIN_URI',
    `mongodb://${str('DB_ADMIN_USER', 'root')}:${str('DB_ADMIN_PASSWORD', 'root')}` +
      `@${str('DB_HOST', 'localhost')}:${int('DB_PORT', 27017)}/?authSource=admin`,
  ),

  maxPoolSize: int('MONGO_POOL_MAX', 20),
  minPoolSize: int('MONGO_POOL_MIN', 2),
  serverSelectionTimeoutMS: int('MONGO_CONNECT_TIMEOUT_MS', 5_000),
  socketTimeoutMS: int('MONGO_SOCKET_TIMEOUT_MS', 30_000),
  maxIdleTimeMS: int('MONGO_IDLE_TIMEOUT_MS', 30_000),

  /**
   * Multi-document transactions require a replica set or a sharded cluster; they
   * are the mechanism the trading path depends on. `npm run db:setup` reports
   * clearly when the server cannot provide them rather than failing later inside
   * a trade.
   */
  requireTransactions: !isTest,
};

const env = {
  NODE_ENV,
  isProduction,
  isTest,

  // How many proxies sit in front of this process. 0 means "none", and is the
  // right value for local development: X-Forwarded-For is client-controlled, so
  // trusting it when there is no proxy in front lets anyone spoof their own IP
  // past the rate limiter.
  trustProxyHops: int('TRUST_PROXY_HOPS', 0),

  port: int('PORT', 4000),
  corsOrigin: str('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db,
  jwtSecret,
  jwtExpiresIn: str('JWT_EXPIRES_IN', '8h'),

  sensorKey: str('SENSOR_KEY', ''),

  /**
   * Change streams power the realtime layer, and they only exist on a replica
   * set. On a standalone mongod the listener falls back to explicit emits from
   * the services that mutate, which still works for everything the API itself
   * does — it just cannot see a write made by anything else.
   */
  changeStreams: str('MONGO_CHANGE_STREAMS', 'auto') === 'on',
  replicaSet: str('DB_REPLICA_SET', ''),

  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MIN', 15) * 60_000,
    max: int('RATE_LIMIT_MAX', 300),
    ingestMax: int('INGEST_RATE_LIMIT_MAX', 120),
  },

  // Seeded demo accounts. Read by scripts/seed.js only — nothing in the running
  // application reads these, and they exist so a fresh machine has something to
  // log in with.
  //
  // The passwords are weak on purpose and are stated here as such: these accounts
  // are for a local machine with no real data in it. They are guarded by the same
  // rule as JWT_SECRET — if NODE_ENV=production and the demo admin password is
  // still the example value, the server refuses to start.
  seed: {
    adminEmail: str('DEMO_ADMIN_EMAIL', 'admin@carbonx.local'),
    adminPassword: str('DEMO_ADMIN_PASSWORD', 'Admin@12345'),
    companyEmail: str('DEMO_COMPANY_EMAIL', 'company@carbonx.local'),
    companyPassword: str('DEMO_COMPANY_PASSWORD', 'Company@12345'),
    auditorEmail: str('DEMO_AUDITOR_EMAIL', 'auditor@carbonx.local'),
    auditorPassword: str('DEMO_AUDITOR_PASSWORD', 'Auditor@12345'),
    // The verifier a decision is attributed to when the acting account has no
    // accreditation of its own — an ADMIN. Seeded by scripts/seed.js.
    internalVerifierAccNo: str('INTERNAL_VERIFIER_ACC_NO', 'CX-INTERNAL-0001'),
  },

  // Absolute paths, resolved once so scripts can run from any cwd.
  paths: {
    backend: path.join(__dirname, '..', '..'),
    project: path.join(__dirname, '..', '..', '..'),
    data: path.join(__dirname, '..', '..', '..', 'data'),
  },
};

// A seeded ADMIN account with the example password must never exist in
// production. The JWT secret check above covers the same class of mistake, and this
// is the same reasoning applied to the other credential in the example .env.
if (isProduction && env.seed.adminPassword === 'Admin@12345') {
  throw new Error(
    'DEMO_ADMIN_PASSWORD is still the example value. Set a real one, or unset it, before running in production.',
  );
}

// `data/` holds the CCTS-745 CSV, which is not in version control.
fs.mkdirSync(env.paths.data, { recursive: true });

module.exports = env;
