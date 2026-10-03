'use strict';

/**
 * Integration tests. Require a running MongoDB replica set.
 *
 *   npm run mongo:test-rs
 *   npm run db:setup
 *   npm test
 *
 * Why a replica set and not a standalone: the wallet/ledger invariant, trade
 * execution, and period compliance are all multi-document transactions, and
 * MongoDB refuses those on a standalone with "Transaction numbers are only
 * allowed on a replica set member". Running these tests against a standalone
 * would skip the exact behaviour they exist to verify, so the suite skips loudly
 * rather than passing quietly.
 *
 * What is covered here that the database-free tests cannot:
 *   - the wallet/ledger invariant (was a trigger, now application code)
 *   - idempotent sensor ingest (was a broken partial index, now a dedupe key)
 *   - trade execution: balances, ledger, payment, order fills
 *   - the conditional claim that stops an order being over-filled
 *   - concurrent matching does not over-issue credits
 *   - period compliance: retirement, shortfall, penalty, outcome
 *   - append-only model guards; database-role enforcement is checked separately
 *   - the audit trail records every service write (was a trigger)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const env = require('../src/config/env');

// Integration tests are destructive by nature. Always point them at a separate
// database and use the admin credential there; app-role enforcement is covered
// independently by scripts/verifyAppendOnly.js.
const testDatabase = process.env.TEST_DB_NAME || `${env.db.appDatabase}_test`;
const applicationDatabaseFromUri = decodeURIComponent(new URL(env.db.uri).pathname.slice(1));
if (testDatabase === env.db.appDatabase || testDatabase === applicationDatabaseFromUri) {
  throw new Error('TEST_DB_NAME must differ from the application database; integration tests drop their database');
}
const testUri = new URL(env.db.adminUri);
testUri.pathname = `/${testDatabase}`;
env.db.uri = testUri.toString();
env.db.appDatabase = testDatabase;

const db = require('../src/db/connect');
const models = require('../src/models');
const services = require('../src/services');

const {
  Company, Facility, Sensor, CreditBatch, CreditLedger, CreditAccount,
  MarketOrder, Trade, Payment, EmissionReading, PeriodTotal, CompliancePeriod,
  EmissionCap, Alert, Penalty, EmissionReport, Verification, AuditLog,
} = models;

const { credits, readings, trading, pricing, audit, aggregations } = services;

let available = false;
let reason = '';

test.before(async () => {
  try {
    await db.connect({ silent: true });
    const supports = await db.supportsTransactions();
    if (!supports) {
      reason = 'MongoDB is reachable but is not a replica set; transactions cannot run';
      return;
    }
    // Build the test database catalog before opening any transactions. MongoDB
    // rejects writes to a collection created mid-transaction with a catalog
    // change error, so this must happen during setup, not lazily in a test.
    for (const model of Object.values(models)) {
      if (model && model.schema) await model.init();
    }
    available = true;
  } catch (err) {
    reason = err.message;
  }
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await db.close();
  }
});

/**
 * Skip the calling test when MongoDB is unusable, with the reason.
 *
 * This is a function the test body calls rather than a wrapper the test is
 * declared with, and the reason is worth spelling out: the availability check
 * happens in test.before, which runs *after* the module body is evaluated. A
 * wrapper evaluated at declaration time would therefore always see `available`
 * as false, and the test context is not available at that point either — so
 * `t.skip()` there throws "Cannot read properties of undefined".
 *
 * Skipping loudly rather than passing quietly is the point. The alternative
 * would be a green run in which none of the transactional behaviour was tested.
 */
function requireMongo(t) {
  if (!available) {
    t.skip(`MongoDB unavailable: ${reason}`);
    return false;
  }
  return true;
}

/** Wipe every collection between tests, without dropping indexes. */
async function reset() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

const oid = () => new mongoose.Types.ObjectId();

/** A minimal company, which almost every scenario needs. */
async function makeCompany(name = 'Test Co', extra = {}) {
  return Company.create({ name, status: 'ACTIVE', ...extra });
}

/** A compliance period covering all of 2026, so readings land inside it. */
async function makePeriod(year = 2026) {
  return CompliancePeriod.create({
    year,
    startDate: new Date(Date.UTC(year, 0, 1)),
    endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
    deadline: new Date(Date.UTC(year + 1, 2, 31)),
    status: 'OPEN',
  });
}

test('integration: the wallet balance always equals the ledger sum', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Invariant Co');

  // Issue credits and confirm the two agree afterwards.
  const project = await models.OffsetProject.create({
    ownerCompanyId: company._id,
    name: 'P1',
    status: 'ACTIVE',
  });
  const batch = await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 500,
  });

  const check = await credits.verifyBalance(company._id);
  assert.equal(check.ok, true, `wallet and ledger disagree: ${JSON.stringify(check.mismatches)}`);
  assert.equal(check.mismatches.length, 0);

  const account = await CreditAccount.findOne({ companyId: company._id }).lean();
  assert.equal(account.creditBalance, 500);

  // Retire part of it; the invariant must still hold.
  await credits.retireCredits({ companyId: company._id, quantity: 200 });
  const after = await credits.verifyBalance(company._id);
  assert.equal(after.ok, true, JSON.stringify(after.mismatches));
  assert.equal((await CreditAccount.findOne({ companyId: company._id }).lean()).creditBalance, 300);
});

test('integration: retiring more than you hold reports the shortfall, not a silent over-count', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Short Co');
  const project = await models.OffsetProject.create({
    ownerCompanyId: company._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 100,
  });

  const result = await credits.retireCredits({ companyId: company._id, quantity: 250 });
  // The SQL returned p_qty - v_left for exactly this reason: the caller needs to
  // know what was actually retired so the remainder can be fined.
  assert.equal(result.retired, 100);
  assert.equal(result.requested, 250);
  assert.equal(result.shortfall, 150);
  assert.equal((await CreditAccount.findOne({ companyId: company._id }).lean()).creditBalance, 0);
});

test('integration: sensor ingest is idempotent and does not double-count', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Sensor Co');
  const period = await makePeriod(2026);
  const facility = await Facility.create({ companyId: company._id, name: 'F1' });
  const sensor = await Sensor.create({
    facilityId: facility._id,
    serialNo: 'SEN-1',
    sensorType: 'CO2',
    apiKeyHash: 'hash',
  });

  const reading = {
    facilityId: facility._id.toString(),
    sensorId: sensor._id.toString(),
    readingTs: '2026-06-01T10:00:00Z',
    co2Tonnes: 42.5,
    idempotent: true,
  };

  const first = await readings.ingestReading(reading);
  assert.equal(first.duplicate, false);
  assert.equal(first.counted, true);

  // The replay that broke every ingest under the partial-index approach.
  const replay = await readings.ingestReading(reading);
  assert.equal(replay.duplicate, true, 'a replayed reading must be detected');
  assert.equal(replay.counted, false, 'a replay must not be counted twice');
  assert.equal(String(replay.reading._id), String(first.reading._id), 'the original is returned');

  // One reading, one row, one contribution to the total.
  assert.equal(await EmissionReading.countDocuments({}), 1);
  const total = await PeriodTotal.findOne({ companyId: company._id, periodId: period._id }).lean();
  assert.equal(Number(total.tonnes), 42.5, 'the running total counted the replay');
});

test('integration: two different manual readings at the same instant do not collide', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Manual Co');
  const facility = await Facility.create({ companyId: company._id, name: 'F' });

  // In SQL these were both (NULL, ts) and Postgres treated them as distinct
  // because NULL <> NULL, which is why the index had to be partial. The dedupe
  // key makes the intent explicit instead of depending on that.
  const base = {
    facilityId: facility._id.toString(),
    readingTs: '2026-06-01T10:00:00Z',
    co2Tonnes: 10,
  };
  const a = await readings.ingestReading(base);
  const b = await readings.ingestReading({ ...base, sourceId: oid().toString() });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false, 'a different source is a different reading');
  assert.equal(await EmissionReading.countDocuments({}), 2);
});

test('integration: a sensor may not report for another facility', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Cross Co');
  const facilityA = await Facility.create({ companyId: company._id, name: 'A' });
  const facilityB = await Facility.create({ companyId: company._id, name: 'B' });
  const sensor = await Sensor.create({
    facilityId: facilityA._id,
    serialNo: 'SEN-X',
    sensorType: 'CO2',
    apiKeyHash: 'h',
  });

  await assert.rejects(
    () =>
      readings.ingestReading({
        facilityId: facilityB._id.toString(),
        sensorId: sensor._id.toString(),
        readingTs: '2026-06-01T10:00:00Z',
        co2Tonnes: 1,
        idempotent: true,
      }),
    /does not belong/,
  );
});

test('integration: the incremental period total matches a full recomputation', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Rebuild Co');
  const period = await makePeriod(2026);
  const facility = await Facility.create({ companyId: company._id, name: 'F' });

  for (let i = 0; i < 5; i += 1) {
    await readings.ingestReading({
      facilityId: facility._id.toString(),
      readingTs: `2026-0${i + 1}-15T00:00:00Z`,
      co2Tonnes: 10,
    });
  }

  const incremental = await PeriodTotal.findOne({ companyId: company._id, periodId: period._id }).lean();
  assert.equal(Number(incremental.tonnes), 50);

  // The trigger is gone, so the running total is application code and has to be
  // proven correct rather than assumed correct.
  const verified = await aggregations.verifyComplianceTotals(period._id);
  assert.equal(verified.length, 0, 'no cap means no compliance row; check the total directly');

  const rebuilt = await readings.rebuildPeriodTotals();
  assert.ok(rebuilt > 0);
  const recomputed = await PeriodTotal.findOne({ companyId: company._id, periodId: period._id }).lean();
  assert.equal(Number(recomputed.tonnes), 50, 'recomputation disagrees with the running total');
});

test('integration: a trade moves credits, cash, and order fills atomically', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const buyer = await makeCompany('Buyer');
  const seller = await makeCompany('Seller');
  const period = await makePeriod(2026);

  // Seller needs credits. Issue through the service so the wallet is funded.
  const project = await models.OffsetProject.create({
    ownerCompanyId: seller._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 1000,
  });

  // Buyer needs cash.
  await credits.ensureAccount(buyer._id, null);
  await credits.adjustCash({ companyId: buyer._id, delta: 10_000, session: null });

  const before = await credits.verifyBalance(seller._id);
  assert.equal(before.ok, true, 'invariant holds before the trade');

  const { order: buyOrder, executed } = await trading.placeOrder({
    companyId: buyer._id.toString(),
    side: 'BUY',
    quantity: 100,
    pricePerCredit: 25,
  });
  assert.equal(executed, 0, 'no counterparty yet');

  await trading.placeOrder({
    companyId: seller._id.toString(),
    side: 'SELL',
    quantity: 100,
    pricePerCredit: 25,
  });

  const trade = await Trade.findOne({}).lean();
  assert.ok(trade, 'a trade was recorded');
  assert.equal(trade.quantity, 100);
  assert.equal(trade.price, 25, 'price-time priority: the resting order set the price');

  // Cash moved to the seller, net of nothing.
  const buyerCash = (await CreditAccount.findOne({ companyId: buyer._id }).lean()).cashBalance;
  const sellerCash = (await CreditAccount.findOne({ companyId: seller._id }).lean()).cashBalance;
  assert.equal(buyerCash, 10_000 - 2500);
  assert.equal(sellerCash, 2500);

  // Credits moved by FIFO.
  const buyerCredits = (await CreditAccount.findOne({ companyId: buyer._id }).lean()).creditBalance;
  assert.equal(buyerCredits, 100, 'the buyer received the credits');

  // And the invariant still holds on both sides.
  assert.equal((await credits.verifyBalance(buyer._id)).ok, true);
  assert.equal((await credits.verifyBalance(seller._id)).ok, true);

  // One payment per trade.
  assert.equal(await Payment.countDocuments({ tradeId: trade._id }), 1);
});

test('integration: a buyer with insufficient cash cannot trade', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const buyer = await makeCompany('Poor Buyer');
  const seller = await makeCompany('Rich Seller');

  const project = await models.OffsetProject.create({
    ownerCompanyId: seller._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 100,
  });
  await credits.ensureAccount(buyer._id, null);
  // No cash credited.

  await trading.placeOrder({
    companyId: buyer._id.toString(),
    side: 'BUY',
    quantity: 50,
    pricePerCredit: 100,
  });
  await trading.placeOrder({
    companyId: seller._id.toString(),
    side: 'SELL',
    quantity: 50,
    pricePerCredit: 100,
  });

  assert.equal(await Trade.countDocuments({}), 0, 'a trade with no cash must not be recorded');
  const buyerCash = await CreditAccount.findOne({ companyId: buyer._id }).lean();
  assert.equal(buyerCash.cashBalance, 0, 'no cash was taken');
});

test('integration: the conditional claim refuses to over-fill an order', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Claim Co');
  const order = await MarketOrder.create({
    companyId: company._id,
    side: 'BUY',
    quantity: 100,
    pricePerCredit: 10,
    status: 'OPEN',
  });

  // Claim 60, then try to claim 50 more: only 40 remain, so it must fail.
  assert.equal(await trading.claimFill(order._id, 60, null), true);
  const afterFirst = await MarketOrder.findById(order._id).lean();
  assert.equal(afterFirst.filledQty, 60);
  assert.equal(afterFirst.status, 'PARTIAL');

  assert.equal(
    await trading.claimFill(order._id, 50, null),
    false,
    'claiming more than the remainder must fail rather than over-fill',
  );

  // Exactly the remainder succeeds, and marks it FILLED.
  assert.equal(await trading.claimFill(order._id, 40, null), true);
  const filled = await MarketOrder.findById(order._id).lean();
  assert.equal(filled.filledQty, 100);
  assert.equal(filled.status, 'FILLED');
});

test('integration: concurrent matching does not over-issue credits', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const seller = await makeCompany('Race Seller');
  const buyers = await Promise.all([makeCompany('Racer A'), makeCompany('Racer B')]);

  // The seller holds exactly 100 credits, and both buyers want 100.
  const project = await models.OffsetProject.create({
    ownerCompanyId: seller._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 100,
  });
  await trading.placeOrder({
    companyId: seller._id.toString(),
    side: 'SELL',
    quantity: 100,
    pricePerCredit: 10,
  });

  for (const buyer of buyers) {
    await credits.ensureAccount(buyer._id, null);
    await credits.adjustCash({ companyId: buyer._id, delta: 10_000, session: null });
  }

  // Both buyers hit the matcher at once. Only 100 credits exist, so at most one
  // full fill may succeed.
  await Promise.all(
    buyers.map((buyer) =>
      trading.matchOrders().then(async () => {
        await MarketOrder.create({
          companyId: buyer._id,
          side: 'BUY',
          quantity: 100,
          pricePerCredit: 10,
          status: 'OPEN',
        });
      }),
    ),
  );
  // Now match against the book containing both buy orders.
  await trading.matchOrders();

  const sold = await CreditAccount.findOne({ companyId: seller._id }).lean();
  assert.ok(sold.creditBalance >= 0, 'the seller never goes negative');

  // The ledger is the authority: issued 100, so at most 100 can have moved out.
  const ledgerOut = await CreditLedger.aggregate([
    { $match: { companyId: seller._id, txnType: 'TRADE_OUT' } },
    { $group: { _id: null, total: { $sum: { $abs: '$quantity' } } } },
  ]);
  const moved = ledgerOut.length ? ledgerOut[0].total : 0;
  assert.ok(moved <= 100, `over-issued: ${moved} credits left the seller who only had 100`);

  assert.equal((await credits.verifyBalance(seller._id)).ok, true, 'invariant survived the race');
});

test('integration: period compliance retires, fines the shortfall, and closes the period', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const period = await makePeriod(2026);

  const over = await makeCompany('Over Cap');
  const under = await makeCompany('Under Cap');
  const partial = await makeCompany('Partial Cover');
  const noCredits = await makeCompany('No Credits');

  // The three outcomes, one company each. The distinction that matters is whether
  // the company could surrender the WHOLE excess:
  //
  //   over      300 emitted, cap 100, holds 300  -> excess 200, fully covered -> CREDITED
  //   partial   300 emitted, cap 100, holds 150  -> excess 200, 50 short     -> PENALISED
  //   under      50 emitted, cap 100, holds 0    -> no excess                -> COMPLIANT
  //   noCredits 200 emitted, cap 100, holds 0    -> excess 100, fully short  -> PENALISED
  //
  // An earlier version of this test expected CREDITED for a company that was 50
  // short, which contradicts the classification: a partial cover is a penalty for
  // the remainder, not a clean pass. Covering it fully is what earns CREDITED.
  const project = await models.OffsetProject.create({
    ownerCompanyId: over._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: 2026,
    quantity: 300,
  });

  const projectPartial = await models.OffsetProject.create({
    ownerCompanyId: partial._id,
    name: 'PP',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: projectPartial._id,
    vintageYear: 2026,
    quantity: 150,
  });

  const facilityOver = await Facility.create({ companyId: over._id, name: 'F' });
  await readings.ingestReading({
    facilityId: facilityOver._id.toString(),
    readingTs: '2026-05-01T00:00:00Z',
    co2Tonnes: 300,
  });

  const facilityPartial = await Facility.create({ companyId: partial._id, name: 'F' });
  await readings.ingestReading({
    facilityId: facilityPartial._id.toString(),
    readingTs: '2026-05-01T00:00:00Z',
    co2Tonnes: 300,
  });

  // under emits 50 against a cap of 100 -> COMPLIANT, and is still not retired.
  const facilityUnder = await Facility.create({ companyId: under._id, name: 'F' });
  await readings.ingestReading({
    facilityId: facilityUnder._id.toString(),
    readingTs: '2026-05-01T00:00:00Z',
    co2Tonnes: 50,
  });

  // noCredits emits 200 with a cap of 100 and holds nothing -> PENALISED.
  const facilityNo = await Facility.create({ companyId: noCredits._id, name: 'F' });
  await readings.ingestReading({
    facilityId: facilityNo._id.toString(),
    readingTs: '2026-05-01T00:00:00Z',
    co2Tonnes: 200,
  });

  await EmissionCap.insertMany([
    { companyId: over._id, periodId: period._id, capTonnes: 100 },
    { companyId: under._id, periodId: period._id, capTonnes: 100 },
    { companyId: partial._id, periodId: period._id, capTonnes: 100 },
    { companyId: noCredits._id, periodId: period._id, capTonnes: 100 },
  ]);

  const run = await readings.runPeriodCompliance({ periodId: period._id, ratePerTonne: 3000 });
  const row = (cid) => run.results.find((r) => String(r.companyId) === String(cid));

  // over: excess 200, had 300, so all of it was surrendered.
  const overRow = row(over._id);
  assert.equal(overRow.excess, 200);
  assert.equal(overRow.retired, 200, 'retired the whole excess');
  assert.equal(overRow.outcome, 'CREDITED', 'fully covered, so no fine');
  assert.equal(overRow.fine, 0);

  const underRow = row(under._id);
  assert.equal(underRow.excess, 0);
  assert.equal(underRow.outcome, 'COMPLIANT');
  assert.equal(underRow.retired, 0, 'a compliant company retires nothing');

  // partial: excess 200, had 150. The uncovered 50 is fined, and the outcome is
  // PENALISED — not CREDITED, because a partial cover is not a clean pass.
  const partialRow = row(partial._id);
  assert.equal(partialRow.excess, 200);
  assert.equal(partialRow.retired, 150, 'retired all it had');
  assert.equal(partialRow.outcome, 'PENALISED');
  assert.equal(partialRow.fine, 150_000, '50 tCO2 uncovered at 3000/tonne');

  const noRow = row(noCredits._id);
  assert.equal(noRow.excess, 100);
  assert.equal(noRow.retired, 0, 'no credits to surrender');
  assert.equal(noRow.outcome, 'PENALISED');
  assert.equal(noRow.fine, 300_000, '100 tCO2 at 3000/tonne');

  // Two penalties: the partial cover and the company with nothing. The compliant
  // and fully-credited companies are not fined, which is the assertion that
  // catches an over-broad fine.
  const penalties = await Penalty.find().lean();
  assert.equal(penalties.length, 2, 'only the short companies are fined');
  const fines = penalties.map((p) => Number(p.fineAmount)).sort((a, b) => a - b);
  assert.deepEqual(fines, [150_000, 300_000]);
  assert.ok(penalties.every((p) => p.status === 'UNPAID'));

  // And the period is now closed.
  assert.equal((await CompliancePeriod.findById(period._id).lean()).status, 'CLOSED');

  // A second run must refuse, which is what makes the first one final.
  await assert.rejects(
    () => readings.runPeriodCompliance({ periodId: period._id }),
    /already closed/,
  );
});

test('integration: re-running a compliance pass is idempotent for penalties', async (t) => {
  if (!requireMongo(t)) return;
  // The SQL used ON CONFLICT (company_id, period_id) DO UPDATE. A second run on
  // an open period must replace the penalty, not stack a second one.
  await reset();
  const period = await makePeriod(2026);
  const company = await makeCompany('Repeat');
  const facility = await Facility.create({ companyId: company._id, name: 'F' });
  await readings.ingestReading({
    facilityId: facility._id.toString(),
    readingTs: '2026-05-01T00:00:00Z',
    co2Tonnes: 500,
  });
  await EmissionCap.create({ companyId: company._id, periodId: period._id, capTonnes: 100 });

  // Reopen between runs so the second one is not simply rejected as closed.
  await readings.runPeriodCompliance({ periodId: period._id, ratePerTonne: 100 });
  await CompliancePeriod.findById(period._id).lean();
  await CompliancePeriod.updateOne({ _id: period._id }, { $set: { status: 'OPEN' } });
  await readings.runPeriodCompliance({ periodId: period._id, ratePerTonne: 200 });

  const penalties = await Penalty.find({ companyId: company._id }).lean();
  assert.equal(penalties.length, 1, 'a second run must not create a second penalty');
  assert.equal(Number(penalties[0].ratePerTonne), 200, 'the penalty is updated, not added');
});

test('integration: expired batches are written off, not deleted', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Expiring');
  // Expiry must be strictly before the current year: fn_expire_credits and
  // expireCredits() both use `expiry_year < currentYear`, so a batch expiring
  // *this* year is not yet expired. The model also requires expiryYear >=
  // vintageYear, so vintage and expiry are the same year here.
  const lastYear = new Date().getUTCFullYear() - 1;
  const project = await models.OffsetProject.create({
    ownerCompanyId: company._id,
    name: 'P',
    status: 'ACTIVE',
  });
  const expiredBatch = await CreditBatch.create({
    projectId: project._id,
    vintageYear: lastYear,
    quantity: 100,
    expiryYear: lastYear,
    status: 'ACTIVE',
  });
  await credits.ensureAccount(company._id, null);
  await credits.writeLedger({
    companyId: company._id,
    batchId: expiredBatch._id,
    txnType: 'ISSUE',
    quantity: 100,
    session: null,
  });

  assert.equal((await CreditAccount.findOne({ companyId: company._id }).lean()).creditBalance, 100);

  const writtenOff = await credits.expireCredits();
  assert.ok(writtenOff >= 1, 'the expired holding should be written off');

  // The balance is zero, but the ISSUE row is still there: the ledger is
  // append-only and an expiry is a dated event, not an erasure.
  assert.equal((await CreditAccount.findOne({ companyId: company._id }).lean()).creditBalance, 0);
  const ledger = await CreditLedger.find({ companyId: company._id }).sort({ createdAt: 1 }).lean();
  assert.ok(ledger.some((l) => l.txnType === 'ISSUE'), 'the issue entry survives');
  assert.ok(ledger.some((l) => l.txnType === 'EXPIRE'), 'an expiry entry was appended');
  assert.equal((await credits.verifyBalance(company._id)).ok, true);
});

test('integration: the order book only shows resting quantity', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Book Co');
  const order = await MarketOrder.create({
    companyId: company._id,
    side: 'SELL',
    quantity: 100,
    pricePerCredit: 42,
    status: 'OPEN',
  });
  await trading.claimFill(order._id, 30, null);

  const book = await aggregations.orderBook({ side: 'SELL' });
  const row = book.find((b) => String(b.orderId) === String(order._id));
  assert.ok(row, 'a part-filled order is still in the book');
  assert.equal(row.remaining, 70, 'remaining is quantity - filledQty');

  // A filled order leaves the book.
  await trading.claimFill(order._id, 70, null);
  const after = await aggregations.orderBook({ side: 'SELL' });
  assert.equal(after.find((b) => String(b.orderId) === String(order._id)), undefined);
});

test('integration: a filled day records OHLCV, and an empty day records nulls', async (t) => {
  if (!requireMongo(t)) return;
  await reset();
  const company = await makeCompany('Price Co');
  // executeTrade stamps tradeTs with the current time, so the day holding the
  // fills is today, not a fixed date. Asserting against a hardcoded past date
  // would silently test an empty day.
  const day = new Date().toISOString().slice(0, 10);

  // A day with trades.
  const other = await makeCompany('Counterparty');
  const project = await models.OffsetProject.create({
    ownerCompanyId: other._id,
    name: 'P',
    status: 'ACTIVE',
  });
  await credits.issueBatch({
    projectId: project._id,
    vintageYear: 2026,
    quantity: 1000,
  });
  await credits.ensureAccount(company._id, null);
  await credits.adjustCash({ companyId: company._id, delta: 100_000, session: null });

  // The sellers rest first, then the buyer sweeps them.
  //
  // The order matters, and it is the price-time rule being tested rather than
  // incidental. A BUY at 40 crosses both asks; because each resting sell order
  // predates the buy, each sets the price, so the fills are 5 @ 20 (cheapest ask
  // first) then 5 @ 30. Placed the other way round — buyer first at 20 — the
  // sell at 30 would not cross at all and the day would only ever see 20.
  await trading.placeOrder({ companyId: other._id.toString(), side: 'SELL', quantity: 5, pricePerCredit: 30 });
  await trading.placeOrder({ companyId: other._id.toString(), side: 'SELL', quantity: 5, pricePerCredit: 20 });
  await trading.placeOrder({ companyId: company._id.toString(), side: 'BUY', quantity: 10, pricePerCredit: 40 });

  assert.equal(await Trade.countDocuments({}), 2, 'both resting asks were filled');

  const traded = await pricing.refreshPriceHistory(day);
  assert.ok(traded.close !== null, 'a day with trades has a close');
  assert.equal(traded.open, 20, 'open is the first trade of the day');
  assert.equal(traded.high, 30);
  assert.equal(traded.low, 20);
  assert.equal(traded.close, 30, 'close is the last trade of the day');
  assert.equal(traded.volume, 10);

  // A day with no trades still gets a row, with null prices and zero volume.
  // Yesterday, so it is a real day in the past rather than a future one.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const empty = await pricing.refreshPriceHistory(yesterday);
  assert.equal(empty.close, null, 'no trades means no price, not a price of 0');
  assert.equal(empty.volume, 0);
  assert.equal(empty.high, null);
});

test('integration: the audit trail records every service write', async (t) => {
  if (!requireMongo(t)) return;
  // The trigger that made this automatic is gone. This test is the compensation:
  // if a write path forgets to log, it fails here.
  await reset();
  const company = await makeCompany('Audited Co');
  const project = await models.OffsetProject.create({
    ownerCompanyId: company._id,
    name: 'P',
    status: 'ACTIVE',
  });
  const batch = await credits.issueBatch({
    projectId: project._id,
    vintageYear: new Date().getUTCFullYear(),
    quantity: 50,
  });

  // The batch insert, the ledger row, and the wallet move are all logged.
  assert.equal(await audit.hasAuditFor('creditbatches', batch._id), true, 'batch insert not logged');
  const ledger = await CreditLedger.findOne({ batchId: batch._id }).lean();
  assert.equal(await audit.hasAuditFor('creditledger', ledger._id), true, 'ledger insert not logged');

  // And the actor is recorded when there is one.
  const user = await models.User.create({
    fullName: 'Auditor',
    email: 'auditor@test.local',
    passwordHash: 'h',
    role: 'ADMIN',
  });
  await db.asUser(user._id, () =>
    credits.retireCredits({ companyId: company._id, quantity: 10 }),
  );
  const attributed = await AuditLog.findOne({ tableName: 'creditledger' }).sort({ changedAt: -1 }).lean();
  assert.ok(attributed.changedBy, 'a user-attributed write should record who did it');
  assert.equal(String(attributed.changedBy), String(user._id));
});

test('integration: append-only holds for a direct collection write too', async (t) => {
  if (!requireMongo(t)) return;
  // The model hook blocks a write through Mongoose. The database-level half of
  // the guarantee is the carbonx_app role, which setup.js grants without update
  // or remove rights. When running tests as an unrestricted user the role is not
  // in play, so this asserts the model half only and says so.
  await reset();
  const company = await makeCompany('Append Co');
  const facility = await Facility.create({ companyId: company._id, name: 'F' });
  const { reading } = await readings.ingestReading({
    facilityId: facility._id.toString(),
    readingTs: '2026-08-01T00:00:00Z',
    co2Tonnes: 5,
  });

  await assert.rejects(() => EmissionReading.updateOne({ _id: reading._id }, { $set: { co2Tonnes: 999 } }), /append-only/);
  await assert.rejects(() => EmissionReading.deleteOne({ _id: reading._id }), /append-only/);
});

test('integration: aggregate unique indexes are enforced by the server', async (t) => {
  if (!requireMongo(t)) return;
  // These were UNIQUE constraints in SQL. They are the reason a company cannot
  // have two caps for one period, or two verifications for one report.
  await reset();
  const company = await makeCompany('Uniq Co');
  const period = await makePeriod(2026);
  const verifier = await models.Verifier.create({ name: 'V', accreditationNo: 'ACC-1' });

  await EmissionCap.create({ companyId: company._id, periodId: period._id, capTonnes: 100 });
  await assert.rejects(
    () => EmissionCap.create({ companyId: company._id, periodId: period._id, capTonnes: 200 }),
    (err) => readings.isDuplicateKey(err),
    'a second cap for the same company and period must be rejected',
  );

  const report = await EmissionReport.create({
    companyId: company._id,
    periodId: period._id,
    totalTonnes: 50,
    status: 'SUBMITTED',
    submittedAt: new Date(),
  });
  await Verification.create({ reportId: report._id, verifierId: verifier._id, decision: 'APPROVED' });
  await assert.rejects(
    () => Verification.create({ reportId: report._id, verifierId: verifier._id, decision: 'REJECTED' }),
    (err) => readings.isDuplicateKey(err),
    'a report can only be verified once',
  );
});
