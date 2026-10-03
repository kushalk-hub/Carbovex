'use strict';

/** HTTP smoke check for the MongoDB-backed API. Start the API and seed demo data first. */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const env = require('../src/config/env');
const db = require('../src/db/connect');
const { Sensor, CreditLedger, EmissionReading } = require('../src/models');

const BASE = process.env.BASE_URL || `http://localhost:${env.port}`;
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD || env.seed.adminPassword;
let passed = 0;
let failed = 0;

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
  return { status: res.status, body: json };
}

function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`CarbonX smoke test against ${BASE}`);
  await db.connect({ silent: true });
  const health = await api('/health');
  check('health endpoint reports database up', health.status === 200 && health.body.database === 'up');
  if (health.status !== 200) throw new Error(`API unavailable at ${BASE}`);

  const admin = await api('/api/auth/login', {
    method: 'POST', body: { email: env.seed.adminEmail, password: PASSWORD },
  });
  check('seeded admin can log in', admin.status === 200);
  if (admin.status !== 200) throw new Error('Seed demo accounts with npm run db:seed -- --demo');
  const token = admin.body.token;
  const companyLogin = await api('/api/auth/login', {
    method: 'POST', body: { email: env.seed.companyEmail, password: env.seed.companyPassword },
  });
  const auditorLogin = await api('/api/auth/login', {
    method: 'POST', body: { email: env.seed.auditorEmail, password: env.seed.auditorPassword },
  });
  check('seeded company can log in', companyLogin.status === 200);
  check('seeded auditor can log in', auditorLogin.status === 200);
  const companyToken = companyLogin.body?.token;
  const companyId = companyLogin.body?.user?.companyId;
  const auditorToken = auditorLogin.body?.token;

  const getProbes = [
    ['GET /', '/', null],
    ['GET /api/auth/me', '/api/auth/me', token],
    ['GET /api/admin/overview', '/api/admin/overview', token],
    ['GET /api/alerts', '/api/alerts', token],
    ['GET /api/companies', '/api/companies', token],
    ['GET company compliance', `/api/companies/${companyId}/compliance`, token],
    ['GET company dashboard', `/api/companies/${companyId}/dashboard`, token],
    ['GET /api/market/trades', '/api/market/trades', token],
    ['GET /api/orders/mine', '/api/orders/mine', companyToken],
    ['GET /api/penalties', '/api/penalties', companyToken],
    ['GET /api/projects', '/api/projects', token],
    ['GET /api/reports', '/api/reports', companyToken],
    ['GET /api/reports/queue', '/api/reports/queue', auditorToken],
    ['GET /api/stats/overview', '/api/stats/overview', token],
    ['GET /api/wallet', '/api/wallet', companyToken],
    ['GET /api/wallet/holdings', '/api/wallet/holdings', companyToken],
    ['GET /api/wallet/ledger', '/api/wallet/ledger', companyToken],
    ['GET /api/wallet/retirements', '/api/wallet/retirements', companyToken],
  ];
  for (const [label, path, authToken] of getProbes) {
    const result = await api(path, authToken ? { token: authToken } : {});
    check(label, result.status === 200, result.body?.error ?? `HTTP ${result.status}`);
  }

  const facilities = await api('/api/facilities', { token });
  check('facilities endpoint returns data', facilities.status === 200 && Array.isArray(facilities.body.facilities));
  check('facility IDs use ObjectId JSON strings',
    facilities.status === 200 && (!facilities.body.facilities[0] || /^[a-f\d]{24}$/i.test(facilities.body.facilities[0].id)));
  const facilityId = facilities.body?.facilities?.[0]?.id;
  if (facilityId) {
    const detail = await api(`/api/facilities/${facilityId}`, { token });
    check('GET facility detail', detail.status === 200, detail.body?.error ?? `HTTP ${detail.status}`);
    for (const bucket of ['day', 'month']) {
      const series = await api(`/api/facilities/${facilityId}/readings?bucket=${bucket}`, { token });
      check(`GET facility readings (${bucket})`, series.status === 200, series.body?.error ?? `HTTP ${series.status}`);
    }
  }
  const depth = await api('/api/market/depth?levels=10', { token });
  check('market depth endpoint responds', depth.status === 200);
  const prices = await api('/api/market/prices?days=14', { token });
  check('daily price history endpoint responds', prices.status === 200);
  const audit = await api('/api/audit-log?limit=5', { token });
  check('audit endpoint responds', audit.status === 200);

  const sensor = await Sensor.findOne({ status: 'ONLINE' }).sort({ serialNo: 1 }).lean();
  check('an online sensor exists', Boolean(sensor));
  if (sensor) {
    const ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const payload = { sensorId: String(sensor._id), readings: [{ ts, tonnes: 1.25, verified: false }] };
    const headers = { 'X-API-Key': env.sensorKey || 'cx_demo_sensor_key_0001' };
    const first = await api('/api/readings', { method: 'POST', body: payload, headers });
    check('sensor ingest accepts a reading', first.status === 201, first.body?.error ?? `HTTP ${first.status}`);
    const retry = await api('/api/readings', { method: 'POST', body: payload, headers });
    check('sensor ingest retry is idempotent', retry.status === 201 && retry.body.inserted === 0 && retry.body.duplicates === 1,
      retry.body?.error ?? `HTTP ${retry.status}`);
    const recent = await api('/api/readings/recent', { headers: { 'X-API-Key': headers['X-API-Key'] } });
    check('GET sensor recent readings', recent.status === 200, recent.body?.error ?? `HTTP ${recent.status}`);
  }
  const auditLookup = await api('/api/reports/000000000000000000000000/audit', { token: auditorToken });
  check('GET report audit lookup returns an empty audit for an unknown ID',
    auditLookup.status === 200 && auditLookup.body?.audit === null);
  const projectLookup = await api('/api/projects/000000000000000000000000', { token });
  check('GET project detail lookup returns not found for an unknown ID', projectLookup.status === 404);

  const native = db.mongoose.connection.db;
  const ledger = await CreditLedger.findOne().select('_id').lean();
  if (ledger) {
    try {
      await native.collection('creditledger').updateOne({ _id: ledger._id }, { $set: { quantity: 0 } });
      check('database role blocks ledger updates', false, 'review the append-only grants');
    } catch (err) {
      check('database role blocks ledger updates', true, err.codeName || err.message.slice(0, 80));
    }
  }
  const reading = await EmissionReading.findOne().select('_id').lean();
  if (reading) {
    try {
      await native.collection('emissionreadings').deleteOne({ _id: reading._id });
      check('database role blocks reading deletes', false, 'review the append-only grants');
    } catch (err) {
      check('database role blocks reading deletes', true, err.codeName || err.message.slice(0, 80));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

main()
  .then((code) => db.close().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(`Smoke test failed: ${err.message}`);
    await db.close().catch(() => {});
    process.exit(1);
  });
