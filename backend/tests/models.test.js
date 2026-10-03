'use strict';

/**
 * Model constraint tests.
 *
 * These run without a database, which is the point: schema validation happens in
 * Mongoose before anything is sent to the server, so the integrity rules can be
 * tested in isolation. The unique *indexes* (dedupeKey, one cap per period, one
 * verification per report) are a different mechanism and need a live server —
 * see tests/integration.test.js.
 *
 * Every test in this file corresponds to a CHECK constraint or trigger from
 * legacy-postgres. If one of these fails, the corresponding database guarantee
 * has been lost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  User,
  CompliancePeriod,
  CreditBatch,
  CreditLedger,
  MarketOrder,
  Trade,
  EmissionReading,
} = require('../src/models');

const oid = (n) => new mongoose.Types.ObjectId('65b00000000000000000000' + n);

/** Assert that a document is rejected, and return the ValidationError. */
async function rejects(make) {
  try {
    await make().validate();
  } catch (err) {
    assert.ok(
      err instanceof mongoose.Error.ValidationError,
      `expected a ValidationError, got ${err.name}: ${err.message}`,
    );
    return err;
  }
  assert.fail('document was accepted but should have been rejected');
}

/** Assert that a document is accepted. */
async function accepts(make) {
  await make().validate();
}

test('models: all 33 register under the collection names the app depends on', () => {
  const models = require('../src/models');
  const names = Object.keys(models).filter((k) => typeof models[k] === 'function' && models[k].schema);
  assert.equal(names.length, 33);

  // Spelled out rather than derived. Ten of these are irregular — Country is
  // 'countries' not 'countrys', CreditLedger is 'creditledger' not
  // 'creditledgers' — and Mongoose's default pluralisation would silently pick
  // the wrong one for those. The names are the legacy SQL table names, and they
  // are load-bearing: scripts/setup.js builds the least-privilege grants and the
  // change streams address collections by name, so a mismatch here is a
  // permission or a silently dead realtime channel in production, not a
  // cosmetic diff.
  const expected = {
    Country: 'countries',
    State: 'states',
    City: 'cities',
    Sector: 'sectors',
    Verifier: 'verifiers',
    FacilityType: 'facilitytypes',
    FuelType: 'fueltypes',
    Registry: 'registries',
    ProjectType: 'projecttypes',
    EmissionSource: 'emissionsources',
    CompliancePeriod: 'complianceperiods',
    Company: 'companies',
    User: 'users',
    Facility: 'facilities',
    FacilityFuel: 'facilityfuels',
    Sensor: 'sensors',
    PeriodTotal: 'periodtotals',
    EmissionReading: 'emissionreadings',
    EmissionCap: 'emissioncaps',
    Alert: 'alerts',
    EmissionReport: 'emissionreports',
    Verification: 'verifications',
    OffsetProject: 'offsetprojects',
    CreditBatch: 'creditbatches',
    CreditAccount: 'creditaccounts',
    CreditLedger: 'creditledger',
    CreditRetirement: 'creditretirements',
    Penalty: 'penalties',
    MarketOrder: 'marketorders',
    Trade: 'trades',
    Payment: 'payments',
    PriceHistory: 'pricehistory',
    AuditLog: 'auditlog',
  };

  for (const [name, collection] of Object.entries(expected)) {
    assert.ok(models[name], `${name} is not exported from src/models`);
    assert.equal(models[name].collection.name, collection, `${name} -> wrong collection`);
  }
});

test('cross-field: COMPANY user must belong to a company', async () => {
  await rejects(
    () => new User({ fullName: 'X', email: 'x@y.z', passwordHash: 'h', role: 'COMPANY' }),
  );
  await accepts(
    () =>
      new User({
        fullName: 'X',
        email: 'x@y.z',
        passwordHash: 'h',
        role: 'COMPANY',
        companyId: oid('1'),
      }),
  );
});

test('cross-field: AUDITOR user must be linked to a verifier', async () => {
  // Stricter than the SQL, which only enforced the COMPANY half.
  await rejects(
    () => new User({ fullName: 'X', email: 'x@y.z', passwordHash: 'h', role: 'AUDITOR' }),
  );
  await accepts(
    () =>
      new User({
        fullName: 'X',
        email: 'x@y.z',
        passwordHash: 'h',
        role: 'AUDITOR',
        verifierId: oid('2'),
      }),
  );
});

test('cross-field: ADMIN needs neither a company nor a verifier', async () => {
  await accepts(
    () => new User({ fullName: 'X', email: 'x@y.z', passwordHash: 'h', role: 'ADMIN' }),
  );
});

test('cross-field: a compliance period cannot end before it starts', async () => {
  await rejects(
    () =>
      new CompliancePeriod({
        year: 2026,
        startDate: new Date('2026-12-31'),
        endDate: new Date('2026-01-01'),
        deadline: new Date('2027-01-01'),
      }),
  );
  await accepts(
    () =>
      new CompliancePeriod({
        year: 2026,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        deadline: new Date('2027-01-01'),
      }),
  );
});

test('cross-field: a batch cannot expire before its vintage', async () => {
  await rejects(
    () => new CreditBatch({ projectId: oid('1'), vintageYear: 2024, quantity: 100, expiryYear: 2020 }),
  );
  await accepts(
    () => new CreditBatch({ projectId: oid('1'), vintageYear: 2024, quantity: 100, expiryYear: 2024 }),
  );
  // A null expiry is a non-expiring batch, which the SQL allowed.
  await accepts(
    () => new CreditBatch({ projectId: oid('1'), vintageYear: 2024, quantity: 100, expiryYear: null }),
  );
});

test('cross-field: an order cannot be overfilled', async () => {
  // This is the guard that would catch a matching bug handing out more credits
  // than were ordered.
  await rejects(
    () =>
      new MarketOrder({
        companyId: oid('1'),
        side: 'BUY',
        quantity: 10,
        filledQty: 11,
        pricePerCredit: 5,
      }),
  );
  await accepts(
    () =>
      new MarketOrder({
        companyId: oid('1'),
        side: 'BUY',
        quantity: 10,
        filledQty: 10,
        pricePerCredit: 5,
      }),
  );
  // Default filledQty is 0, so a fresh order must validate.
  await accepts(
    () => new MarketOrder({ companyId: oid('1'), side: 'BUY', quantity: 10, pricePerCredit: 5 }),
  );
});

test('cross-field: a trade cannot be against itself', async () => {
  await rejects(
    () => new Trade({ buyOrderId: oid('5'), sellOrderId: oid('5'), quantity: 1, price: 1 }),
  );
  await accepts(
    () => new Trade({ buyOrderId: oid('5'), sellOrderId: oid('6'), quantity: 1, price: 1 }),
  );
});

test('cross-field: a zero-quantity ledger entry is refused', async () => {
  await rejects(
    () =>
      new CreditLedger({
        companyId: oid('1'),
        batchId: oid('2'),
        txnType: 'TRADE_IN',
        quantity: 0,
      }),
  );
  // Negative quantities are normal and must be allowed: the ledger is signed.
  await accepts(
    () =>
      new CreditLedger({
        companyId: oid('1'),
        batchId: oid('2'),
        txnType: 'TRADE_OUT',
        quantity: -50,
      }),
  );
});

test('append-only: emission readings cannot be updated or deleted', async () => {
  const attempts = [
    ['updateOne', () => EmissionReading.updateOne({}, {})],
    ['updateMany', () => EmissionReading.updateMany({}, {})],
    ['findOneAndUpdate', () => EmissionReading.findOneAndUpdate({}, {})],
    ['replaceOne', () => EmissionReading.replaceOne({}, {})],
    ['deleteOne', () => EmissionReading.deleteOne({})],
    ['deleteMany', () => EmissionReading.deleteMany({})],
    ['findOneAndDelete', () => EmissionReading.findOneAndDelete({})],
  ];
  for (const [label, run] of attempts) {
    await assert.rejects(run, /append-only/, `${label} was allowed on an append-only collection`);
  }
});

test('append-only: the credit ledger cannot be updated or deleted', async () => {
  await assert.rejects(() => CreditLedger.updateOne({}, {}), /append-only/);
  await assert.rejects(() => CreditLedger.deleteMany({}), /append-only/);
});

test('idempotency: dedupeKey is required and always non-null', async () => {
  // The reason this is a plain required string rather than a partial index on
  // sensorId: see the dedupeKey comment in models/emissions.js.
  await rejects(
    () => new EmissionReading({ facilityId: oid('1'), readingTs: new Date(), co2Tonnes: 1 }),
  );
  await accepts(
    () =>
      new EmissionReading({
        facilityId: oid('1'),
        readingTs: new Date(),
        co2Tonnes: 1,
        dedupeKey: 's:abc:2026-01-01T00:00:00.000Z',
      }),
  );
});

test('idempotency: dedupeKeyFor produces stable, distinct keys', () => {
  const { dedupeKeyFor } = require('../src/models');
  const ts = '2026-03-01T00:00:00Z';

  // Same sensor and timestamp is always the same key: that is what makes a
  // retried upload idempotent.
  assert.equal(
    dedupeKeyFor({ sensorId: '65abc', facilityId: '65def', readingTs: ts }),
    dedupeKeyFor({ sensorId: '65abc', facilityId: '65def', readingTs: ts }),
  );
  // Different timestamps differ.
  assert.notEqual(
    dedupeKeyFor({ sensorId: '65abc', facilityId: '65def', readingTs: ts }),
    dedupeKeyFor({ sensorId: '65abc', facilityId: '65def', readingTs: '2026-03-01T00:01:00Z' }),
  );
  // Manual readings must not collide with each other when no sensor or source
  // is given. In SQL these would both be (NULL, ts) and Postgres would have
  // treated them as distinct because NULL <> NULL.
  assert.notEqual(
    dedupeKeyFor({ facilityId: '65def', readingTs: ts }),
    dedupeKeyFor({ facilityId: '65def', readingTs: ts, sourceId: '65aaa' }),
  );
  // And they must not collide with sensor readings either.
  assert.notEqual(
    dedupeKeyFor({ facilityId: '65def', readingTs: ts }),
    dedupeKeyFor({ sensorId: '65abc', facilityId: '65def', readingTs: ts }),
  );
});

test('enum and range: bad values are rejected', async () => {
  await rejects(
    () => new MarketOrder({ companyId: oid('1'), side: 'HODL', quantity: 1, pricePerCredit: 1 }),
  );
  await rejects(
    () => new EmissionReading({ facilityId: oid('1'), readingTs: new Date(), co2Tonnes: -1, dedupeKey: 'k' }),
  );
  await rejects(() => new MarketOrder({ companyId: oid('1'), side: 'BUY', quantity: 0, pricePerCredit: 1 }));
});
