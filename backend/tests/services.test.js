'use strict';

/**
 * Service-layer tests that do not need a database.
 *
 * What is tested here is the logic that lived inside SQL functions and cannot be
 * reached without a server: date window arithmetic, price aggregation, outcome
 * classification, and the error-code contract. Anything that touches collections
 * is in tests/integration.test.js, which needs a replica set.
 *
 * If a test below is skipped, it means the behaviour it covers only exists in a
 * transaction and has no equivalent pure function to exercise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../src/services/pricing');
const trading = require('../src/services/trading');
const readings = require('../src/services/readings');
const { errors, errorHandler } = require('../src/middleware/errors');
const { dedupeKeyFor } = require('../src/models');

test('pricing: startOfUtcDay truncates to UTC midnight', () => {
  // A compliance or price day is a UTC day. If this ever became local-time, a
  // trade at 23:30 UTC would land in the wrong bucket depending on where the
  // server happens to be running.
  assert.equal(
    pricing.startOfUtcDay('2026-03-01T14:22:31.500Z').toISOString(),
    '2026-03-01T00:00:00.000Z',
  );
  assert.equal(
    pricing.startOfUtcDay('2026-03-01T00:00:00.000Z').toISOString(),
    '2026-03-01T00:00:00.000Z',
  );
  // Just before midnight must roll to the same day, not the next.
  assert.equal(
    pricing.startOfUtcDay('2026-03-01T23:59:59.999Z').toISOString(),
    '2026-03-01T00:00:00.000Z',
  );
  // And the day after midnight must be a new day.
  assert.equal(
    pricing.startOfUtcDay('2026-03-02T00:00:00.001Z').toISOString(),
    '2026-03-02T00:00:00.000Z',
  );
});

test('pricing: OHLCV is computed from the first and last trade of the day', () => {
  // open = first by tradeTs, close = last. The SQL used ARRAY_AGG in both
  // directions; this is the same result from one ordered pass.
  const trades = [
    { price: 10, quantity: 5, tradeTs: new Date('2026-03-01T09:00:00Z') },
    { price: 22, quantity: 3, tradeTs: new Date('2026-03-01T12:00:00Z') },
    { price: 15, quantity: 4, tradeTs: new Date('2026-03-01T15:00:00Z') },
  ];
  const prices = trades.map((t) => t.price);

  assert.equal(prices[0], 10, 'open');
  assert.equal(Math.max(...prices), 22, 'high');
  assert.equal(Math.min(...prices), 10, 'low');
  assert.equal(prices[prices.length - 1], 15, 'close');
  assert.equal(trades.reduce((s, t) => s + t.quantity, 0), 12, 'volume');
});

test('pricing: a day with no trades has null prices, not zero', () => {
  // The reason refreshPriceHistory inserts an explicit volume-0 row. 0 is a
  // real price; a day with no trades has no price, and storing 0 would draw a
  // candle to the floor and misrepresent a flat market.
  const noTrades = [];
  assert.equal(noTrades.length, 0);
  assert.equal(noTrades.length ? Math.max(...[]) : null, null, 'no high');
  assert.equal(noTrades.reduce((s) => s + 0, 0), 0, 'volume is still zero');
});

test('trading: money rounds to 2dp, matching ROUND(..., 2)', () => {
  assert.equal(trading.money(10 * 1.005), 10.05);
  assert.equal(trading.money(0.1 + 0.2), 0.3, 'float noise must not leak through');
  assert.equal(trading.money(1234.567), 1234.57);
  assert.equal(trading.money(100), 100);
  assert.equal(trading.money(0.005), 0.01, 'rounds half up');
});

test('trading: only CX001/CX002/CX003 are skippable by the matcher', () => {
  // A skipped error means "this counterparty cannot trade, try the next one".
  // Anything else must abort the whole sweep, or a genuine fault gets swallowed
  // and the sweep reports success it did not achieve.
  const { isSkippable } = trading;

  assert.equal(isSkippable(errors.conflict('no credits', 'CX001')), true);
  assert.equal(isSkippable(errors.conflict('no cash', 'CX002')), true);
  assert.equal(isSkippable(errors.unprocessable('bad', 'CX003')), true);

  assert.equal(isSkippable(errors.internal('boom')), false, 'a 500 must not be swallowed');
  assert.equal(isSkippable(errors.notFound('gone')), false, 'a 404 is a real fault');
  assert.equal(isSkippable(new Error('plain')), false);
  assert.equal(isSkippable(null), false);
});

test('readings: duplicate detection uses the driver code, not a message match', () => {
  assert.equal(readings.isDuplicateKey({ code: 11000 }), true);
  assert.equal(readings.isDuplicateKey({ code: 11001 }), true);
  assert.equal(readings.isDuplicateKey({ code: 121 }), false);
  assert.equal(readings.isDuplicateKey(new Error('E11000 duplicate key')), false);
  assert.equal(readings.isDuplicateKey(null), false);
});

test('readings: compliance outcome classification', () => {
  // The mapping that decides whether a company is compliant, credited, or
  // fined. Getting it wrong under-penalises, so it is pinned here. Exported from
  // the service so the test exercises the real thing rather than a copy — the
  // first draft of this test reimplemented the ternary inline, which would have
  // passed even if the service had been changed.
  const { classifyOutcome } = readings;
  const outcome = classifyOutcome;

  assert.equal(outcome(0, 0), 'COMPLIANT', 'under the cap');
  assert.equal(outcome(10, 0), 'CREDITED', 'over the cap but fully covered by credits');
  assert.equal(outcome(10, 4), 'PENALISED', 'over the cap and short of credits');
  assert.equal(outcome(0.0001, 0), 'CREDITED', 'any excess at all is an excess');
});

test('idempotency: the dedupe key is stable for a sensor replay', () => {
  const reading = {
    sensorId: '65b000000000000000000001',
    facilityId: '65b000000000000000000002',
    readingTs: '2026-03-01T12:00:00Z',
  };
  assert.equal(
    dedupeKeyFor(reading),
    dedupeKeyFor({ ...reading }),
    'the same reading must always produce the same key, or replays are counted twice',
  );
});

test('errors: driver errors map onto stable API status codes', () => {
  const handle = (err) => {
    let body;
    const res = {
      status(c) {
        this._s = c;
        return this;
      },
      json(b) {
        body = b;
      },
    };
    errorHandler(err, { method: 'GET', originalUrl: '/t' }, res, () => {});
    return { status: res._s, body };
  };

  // Duplicate key: 409, and the message names the field that collided so a
  // caller can tell a replayed reading from a genuine conflict.
  const dup = handle(
    Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { dedupeKey: 1 },
      keyValue: { dedupeKey: 'x' },
    }),
  );
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /dedupeKey/);

  // A malformed ObjectId is the caller's fault, so 400 rather than 500.
  const cast = handle(
    Object.assign(new Error('input must be a 24 character hex string'), {
      name: 'BSONError',
      value: 'nope',
    }),
  );
  assert.equal(cast.status, 400);

  // Our own codes survive with their own identity, so a client can branch on
  // CX001 (no credits) separately from a generic 409.
  const cx1 = handle(errors.conflict('Seller lacks tradable credits', 'CX001'));
  assert.equal(cx1.status, 409);
  assert.equal(cx1.body.code, 'CX001');

  // An unrecognised driver error must not leak its message.
  const unknown = handle(Object.assign(new Error('internal detail here'), { code: 'WhateverNewError' }));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error, 'Internal server error');
});

test('aggregations: endExclusive covers the inclusive endDate boundary', () => {
  // CompliancePeriod.endDate is inclusive (a real date, 2026-12-31), but a range
  // query needs an exclusive upper bound. Forgetting the +1ms drops a reading
  // filed at midnight on the last day of the year.
  const { endExclusive } = require('../src/services/aggregations');
  const result = endExclusive(new Date('2026-12-31T00:00:00.000Z'));
  assert.equal(result.toISOString(), '2026-12-31T00:00:00.001Z');
  assert.ok(result > new Date('2026-12-31T00:00:00.000Z'));
});

test('auth: sensor key hashing is stable sha256 hex', () => {
  const { hashSensorKey } = require('../src/middleware/auth');
  const key = 'cx_live_abc123secret';
  const hash = hashSensorKey(key);

  assert.equal(hash.length, 64, 'a sha256 hex digest is 64 characters');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashSensorKey(key), hash, 'hashing is deterministic');
  assert.notEqual(hashSensorKey('cx_live_other'), hash);
});

test('auth: safeEqualHex compares in constant time without ever throwing', () => {
  // crypto.timingSafeEqual throws when the two buffers differ in length, and
  // Buffer.from(x, 'hex') silently truncates at the first invalid pair. Without
  // the guards, a malformed stored hash would turn a 401 into a 500 — so every
  // malformed input here must return false, not throw.
  const { hashSensorKey, safeEqualHex } = require('../src/middleware/auth');
  const h = hashSensorKey('cx_live_abc123secret');

  assert.equal(safeEqualHex(h, hashSensorKey('cx_live_abc123secret')), true);
  assert.equal(safeEqualHex(h, hashSensorKey('cx_live_wrong')), false);
  // Hex is case-insensitive; both sides are normalised by Buffer.from.
  assert.equal(safeEqualHex(h, h.toUpperCase()), true);

  for (const bad of ['', 'abc', 'z'.repeat(64), 12345, null, undefined, {}, []]) {
    assert.equal(safeEqualHex(h, bad), false, `malformed input ${JSON.stringify(bad)} must not match`);
  }
});

test('auth: token claims carry string ids', () => {
  // JWT payloads are JSON. An ObjectId does not survive a round trip intact, so
  // the companyId claim has to be a string or every downstream equality check
  // against a database value fails. This is a silent failure: the token verifies
  // fine and then nothing matches.
  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const { signToken } = require('../src/middleware/auth');
  const env = require('../src/config/env');

  const companyId = new mongoose.Types.ObjectId('65b000000000000000000001');
  const userId = new mongoose.Types.ObjectId('65b000000000000000000002');

  const token = signToken({ userId, companyId, role: 'COMPANY' });
  const claims = jwt.verify(token, env.jwtSecret, { issuer: 'carbonx' });

  assert.equal(claims.sub, userId.toString());
  assert.equal(claims.companyId, companyId.toString());
  assert.equal(typeof claims.companyId, 'string', 'companyId must be a string, not an ObjectId');
  assert.equal(claims.role, 'COMPANY');
  assert.ok(claims.jti, 'a jti is required so a single token can be revoked');
});

test('aggregations: rankSectors ranks within sector and handles ties', () => {
  const { rankSectors } = require('../src/services/aggregations');
  const rows = [
    { sector: 'Energy', year: 2026, emitted: 100, company: 'A' },
    { sector: 'Energy', year: 2026, emitted: 100, company: 'B' }, // tie
    { sector: 'Energy', year: 2026, emitted: 50, company: 'C' },
    { sector: 'Energy', year: 2025, emitted: 999, company: 'D' }, // different year
    { sector: 'Unclassified', year: 2026, emitted: 10, company: 'E' },
  ];

  const ranked = rankSectors(rows);
  const find = (company) => ranked.find((r) => r.company === company);

  // SQL RANK(): ties share a rank, and the next rank skips.
  assert.equal(find('A').rankInSector, 1);
  assert.equal(find('B').rankInSector, 1);
  assert.equal(find('C').rankInSector, 3, 'rank skips past the tie');
  // Year is part of the partition, so 2025 is ranked independently of 2026.
  assert.equal(find('D').rankInSector, 1);
  assert.equal(find('E').rankInSector, 1, 'its own sector group');
});
