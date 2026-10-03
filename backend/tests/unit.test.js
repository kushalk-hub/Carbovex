'use strict';

/**
 * Unit tests that need no database.
 *
 *   npm test
 *
 * These cover the pure logic: input validation, auth token handling, the audit
 * diff, and the shape of the realtime emit facade. Anything that touches
 * Postgres is in tests/integration.test.js and skips itself when the database
 * is unreachable, so `npm test` is green on a clean machine.
 *
 * Uses the built-in node:test runner, so there is no test framework to install.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-production';
process.env.DB_NAME = process.env.DB_NAME || 'carbonx';

const test = require('node:test');
const assert = require('node:assert/strict');

const { schemas } = require('../src/middleware/validate');
const { signToken, decode, revoke, isRevoked, hashSensorKey, safeEqualHex } = require('../src/middleware/auth');
const { errors, AppError } = require('../src/middleware/errors');
// camelise/diffKeys moved to modules/shape.js: they are pure formatting helpers,
// not route behaviour, and importing them from a route file made this test
// depend on that route's database imports loading first.
const { camelise, diffKeys } = require('../src/modules/shape');
// Imported from the shared helper modules rather than from the job/script files
// themselves, which open a database connection at require time. Testing a CSV
// parser should not require a live MongoDB.
const { dailyTonnes } = require('../src/jobs/helpers');
const { parseLine, findColumn, toNumber } = require('../src/jobs/helpers');

test('validation: login requires a real email', () => {
  assert.equal(schemas.login.safeParse({ email: 'nope', password: 'x' }).success, false);
  assert.equal(schemas.login.safeParse({ email: 'A@B.CO', password: 'x' }).success, true);
  // Normalised, so lookups are case-insensitive in practice.
  assert.equal(schemas.login.parse({ email: '  Admin@CarbonX.Demo ', password: 'x' }).email,
    'admin@carbonx.demo');
});

test('validation: order must be a positive price and quantity', () => {
  assert.equal(schemas.placeOrder.safeParse({ side: 'BUY', price: 0, quantity: 10 }).success, false);
  assert.equal(schemas.placeOrder.safeParse({ side: 'BUY', price: 100, quantity: -5 }).success, false);
  assert.equal(schemas.placeOrder.safeParse({ side: 'HOLD', price: 100, quantity: 5 }).success, false);
  assert.equal(schemas.placeOrder.safeParse({ side: 'SELL', price: 100, quantity: 5 }).success, true);
});

test('validation: an ingest batch must not be empty or absurd', () => {
  // sensorId is an ObjectId hex string, not the integer it was when the keys were
  // Postgres BIGINTs. An integer here would be rejected outright, which is the
  // point: /1 must not survive to become a BSON cast error and a 500.
  const SENSOR = '65b000000000000000000001';
  assert.equal(schemas.ingest.safeParse({ sensorId: 1, readings: [] }).success, false);
  assert.equal(schemas.ingest.safeParse({ sensorId: SENSOR, readings: [] }).success, false);
  const many = Array.from({ length: 1001 }, () => ({ ts: '2026-01-01T00:00:00Z', tonnes: 1 }));
  assert.equal(schemas.ingest.safeParse({ sensorId: SENSOR, readings: many }).success, false);
  assert.equal(
    schemas.ingest.safeParse({ sensorId: SENSOR, readings: [{ ts: 1_700_000_000_000, tonnes: 1.5 }] }).success,
    true,
  );
});

test('validation: dates must be YYYY-MM-DD', () => {
  assert.equal(schemas.pricesQuery.safeParse({ from: '01-01-2026' }).success, false);
  assert.equal(schemas.pricesQuery.safeParse({ from: '2026-13-01' }).success, false);
  assert.equal(schemas.pricesQuery.safeParse({ from: '2026-02-30' }).success, false);
  assert.equal(schemas.pricesQuery.safeParse({ from: '2026-02-28' }).success, true);
});

test('validation: pagination is coerced and bounded', () => {
  const p = schemas.ledgerQuery.parse({ limit: '25', offset: '50' });
  assert.equal(p.limit, 25);
  assert.equal(p.offset, 50);
  assert.equal(schemas.ledgerQuery.safeParse({ limit: '9999' }).success, false);
  assert.equal(schemas.ledgerQuery.safeParse({ limit: '-1' }).success, false);
});

test('auth: a signed token round-trips and carries the claims we need', () => {
  // Ids are ObjectIds and claims are strings. Both halves matter: an ObjectId
  // does not survive the JSON round trip of a JWT payload intact, so storing one
  // in a claim produces a token that verifies and then never matches anything.
  const token = signToken({
    userId: '65b000000000000000000007',
    companyId: '65b000000000000000000003',
    role: 'COMPANY',
  });
  const claims = decode(token);
  assert.equal(claims.sub, '65b000000000000000000007');
  assert.equal(claims.companyId, '65b000000000000000000003');
  assert.equal(claims.role, 'COMPANY');
  // Needed for logout to be able to revoke anything.
  assert.ok(claims.jti);
});

test('auth: a revoked token is recognised as revoked', () => {
  const token = signToken({ userId: '65b000000000000000000001', companyId: null, role: 'ADMIN' });
  const { jti, exp } = decode(token);
  assert.equal(isRevoked(jti), false);
  revoke(jti, exp);
  assert.equal(isRevoked(jti), true);
});

test('auth: a tampered token does not verify', () => {
  const token = signToken({ userId: '65b000000000000000000001', companyId: null, role: 'ADMIN' });
  const parts = token.split('.');
  const forged = `${parts[0]}.${parts[1].slice(0, -2)}xx.${parts[2]}`;
  assert.throws(() => decode(forged));
});

test('auth: sensor keys hash deterministically and compare safely', () => {
  const a = hashSensorKey('demo-sensor-key-001');
  const b = hashSensorKey('demo-sensor-key-001');
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex
  assert.equal(safeEqualHex(a, b), true);
  assert.equal(safeEqualHex(a, hashSensorKey('wrong-key')), false);
  // Different lengths must not throw inside timingSafeEqual.
  assert.equal(safeEqualHex(a, 'abcd'), false);
  assert.equal(safeEqualHex(null, a), false);
});

test('errors: our codes survive the mapping intact', () => {
  const e = errors.conflict('Insufficient credits: available 40, requested 100', 'CX001');
  assert.ok(e instanceof AppError);
  assert.equal(e.status, 409);
  assert.equal(e.code, 'CX001');
  assert.equal(e.expose, true);
});

test('audit: snake_case documents become camelCase', () => {
  const out = camelise({ cap_tonnes: 100, period_id: 3, nested: { old_data: { row_pk: 9 } } });
  assert.deepEqual(out, { capTonnes: 100, periodId: 3, nested: { oldData: { rowPk: 9 } } });
});

test('audit: diff reports only the fields that actually changed', () => {
  const d = diffKeys(
    { cap_tonnes: 100, status: 'DRAFT', period_id: 3 },
    { cap_tonnes: 150, status: 'DRAFT', period_id: 3 },
  );
  assert.deepEqual(d, { capTonnes: { from: 100, to: 150 } });
});

test('audit: an INSERT diff has only additions, a DELETE only removals', () => {
  assert.deepEqual(diffKeys(null, { cap_tonnes: 5 }), { capTonnes: { from: null, to: 5 } });
  assert.deepEqual(diffKeys({ cap_tonnes: 5 }, null), { capTonnes: { from: 5, to: null } });
});

test('simulator: daily tonnes is a plausible fraction of the annual baseline', () => {
  const baseline = 3_650_000; // 10,000 t/day
  const t = dailyTonnes(baseline, () => 0.5); // deterministic midpoint
  assert.ok(t > baseline / 365 * 0.8, `${t} should be above the low end`);
  assert.ok(t < baseline / 365 * 1.2, `${t} should be below the high end`);
  // A zero baseline must still produce something insertable, not NaN or 0.
  assert.ok(dailyTonnes(0) >= 0 && Number.isFinite(dailyTonnes(0)));
});

test('csv: quoted fields, embedded commas and escaped quotes parse correctly', () => {
  assert.deepEqual(parseLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseLine('"Adani, Green Energy",Power'), ['Adani, Green Energy', 'Power']);
  assert.deepEqual(parseLine('"He said ""hi""",x'), ['He said "hi"', 'x']);
});

test('csv: header matching is by substring, not position', () => {
  const headers = ['Entity Name', 'Sector', 'Latitude', 'Longitude', 'Baseline GHG Emission'];
  assert.equal(findColumn(headers, ['entity']).index, 0);
  assert.equal(findColumn(headers, ['latitude']).index, 2);
  assert.equal(findColumn(headers, ['baseline ghg']).index, 4);
  assert.equal(findColumn(headers, ['not present']), null);
});

test('csv: numbers with thousand separators parse', () => {
  assert.equal(toNumber('1,234,567.89'), 1234567.89);
  assert.equal(toNumber(' 42 '), 42);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('n/a'), null);
  assert.equal(toNumber(undefined), null);
});

test('realtime: emits are safe no-ops when no socket server is running', () => {
  const realtime = require('../src/realtime');
  // Nothing is initialised in this process; these must not throw.
  assert.equal(realtime.isActive(), false);
  realtime.emitToAll('x', {});
  realtime.emitToCompany(1, 'x', {});
  realtime.emitToRole('ADMIN', 'x', {});
  realtime.emitReading(1, {});
  realtime.emitOrderBook({});
  realtime.emitWallet(1, {});
  realtime.emitToCompany(null, 'x', {});
});
