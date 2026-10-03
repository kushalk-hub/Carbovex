'use strict';

/**
 * Seed the database.
 *
 *   npm run db:seed              reference data + demo companies
 *   npm run db:seed -- --demo   also create the demo users, sensors and readings
 *   npm run db:seed -- --reset   wipe first
 *
 * The MongoDB replacement for 07_seed_reference.sql and 08_seed_demo.sql, with
 * the same data. It is idempotent: every write is an upsert keyed on a natural
 * key, so running it twice does not duplicate anything. That matters because the
 * reference tables are keyed on names, and re-running a plain INSERT would fail
 * on every unique index.
 *
 * Two phases, and the split is deliberate:
 *
 *   reference  countries, states, cities, sectors, fuels, registries, project
 *              types, emission sources, verifiers, compliance periods. Small,
 *              read-only, and needed by anything else.
 *   demo       companies, users, facilities, sensors, projects, batches, caps.
 *              Only with --demo, because it creates accounts with known
 *              passwords.
 */

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const db = require('../src/db/connect');
const models = require('../src/models');
const { hashSensorKey } = require('../src/middleware/auth');
const { credits, pricing } = require('../src/services');

const {
  Country, State, City, Sector, Verifier, FacilityType, FuelType, Registry,
  ProjectType, EmissionSource, CompliancePeriod, Company, User, Facility,
  FacilityFuel, Sensor, OffsetProject, EmissionCap, Alert,
} = models;

const log = (m) => console.log(`[seed] ${m}`);

/**
 * Upsert by a natural key.
 *
 * The alternative, delete-then-insert, would drop documents other collections
 * reference. Here nothing references reference data by a mutable id in a way that
 * matters, but upserting is still the safer default: it cannot lose data and it
 * makes a re-run a no-op rather than a reset.
 */
async function upsertMany(Model, key, rows) {
  const operations = rows.map((row) => ({
    updateOne: {
      filter: { [key]: row[key] },
      update: { $set: row },
      upsert: true,
    },
  }));
  const result = await Model.bulkWrite(operations, { ordered: false });
  const upserted = result.upsertedCount ?? 0;
  const updated = result.modifiedCount ?? 0;
  return { upserted, updated, total: rows.length };
}

/**
 * India, with real coordinates for 46 cities.
 *
 * The coordinates are the point. GET /api/facilities filters out any facility
 * without a latitude and longitude, so an ungeocoded reference table produces a
 * completely empty globe — a failure that looks like a frontend bug and is not.
 *
 * stateName and countryIso are denormalised onto the city document because the
 * globe and the facility list both need a location label, and a $lookup per city
 * to build one string would be a second round trip for every row returned.
 */
const CITIES = [
  ['Gujarat', 'Ahmedabad', 23.0225, 72.5714], ['Gujarat', 'Vadodara', 22.3072, 73.1812],
  ['Gujarat', 'Surat', 21.1702, 72.8311], ['Gujarat', 'Gandhidham', 23.0756, 70.6361],
  ['Gujarat', 'Jamnagar', 22.4707, 70.0577],
  ['Maharashtra', 'Mumbai', 19.076, 72.8777], ['Maharashtra', 'Pune', 18.5204, 73.8567],
  ['Maharashtra', 'Nashik', 19.9975, 73.7898], ['Maharashtra', 'Nagpur', 21.1458, 79.0882],
  ['Maharashtra', 'Solapur', 17.6599, 75.9064], ['Maharashtra', 'Ratnagiri', 16.9902, 73.312],
  ['Karnataka', 'Bengaluru', 12.9716, 77.5946], ['Karnataka', 'Mangaluru', 12.9141, 74.856],
  ['Karnataka', 'Davanagere', 14.4644, 75.9218], ['Karnataka', 'Ballari', 15.1394, 76.9214],
  ['Tamil Nadu', 'Chennai', 13.0827, 80.2707], ['Tamil Nadu', 'Tuticorin', 8.7642, 78.1348],
  ['Tamil Nadu', 'Kovilpatti', 9.2268, 77.9652], ['Tamil Nadu', 'Salem', 11.6643, 78.146],
  ['Madhya Pradesh', 'Bhopal', 23.2599, 77.4126], ['Madhya Pradesh', 'Singrauli', 24.1994, 82.6754],
  ['Madhya Pradesh', 'Satna', 24.5854, 80.8324],
  ['Rajasthan', 'Jaipur', 26.9124, 75.7873], ['Rajasthan', 'Jodhpur', 26.2389, 73.0243],
  ['Rajasthan', 'Kota', 25.2138, 75.8648],
  ['Uttar Pradesh', 'Kanpur', 26.4499, 80.3319], ['Uttar Pradesh', 'Lucknow', 26.8467, 80.9462],
  ['West Bengal', 'Kolkata', 22.5726, 88.3639], ['West Bengal', 'Haldia', 22.0667, 88.0698],
  ['Odisha', 'Paradip', 20.2648, 86.6947], ['Odisha', 'Rourkela', 22.2604, 84.8536],
  ['Chhattisgarh', 'Raipur', 21.2514, 81.6296], ['Chhattisgarh', 'Korba', 22.3595, 82.7501],
  ['Jharkhand', 'Jamshedpur', 22.8046, 86.2029], ['Jharkhand', 'Dhanbad', 23.7957, 86.4304],
  ['Kerala', 'Kochi', 9.9312, 76.2673], ['Kerala', 'Kannur', 11.8745, 75.3704],
  ['Telangana', 'Hyderabad', 17.385, 78.4867], ['Telangana', 'Ramagundam', 18.7558, 79.474],
  ['Andhra Pradesh', 'Visakhapatnam', 17.6868, 83.2185],
  ['Punjab', 'Ludhiana', 30.901, 75.8573], ['Haryana', 'Panipat', 29.3909, 76.9635],
  ['Uttarakhand', 'Haridwar', 29.9457, 78.1642], ['Himachal Pradesh', 'Parwanoo', 31.1361, 76.5714],
  ['Assam', 'Dibrugarh', 27.4728, 94.992], ['Bihar', 'Patna', 25.5941, 85.1376],
];

const STATES = [
  'Gujarat', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Madhya Pradesh', 'Rajasthan',
  'Uttar Pradesh', 'West Bengal', 'Odisha', 'Chhattisgarh', 'Jharkhand', 'Kerala',
  'Telangana', 'Andhra Pradesh', 'Punjab', 'Haryana', 'Uttarakhand', 'Himachal Pradesh',
  'Assam', 'Bihar',
];

/** tCO2 per unit of fuel. Used to derive implied emissions for facility fuels. */
const FUELS = [
  ['Coal', 'tonne', 2.42],
  ['Natural gas', 'm3', 0.00202],
  ['Diesel', 'kL', 2.68],
  ['Fuel oil', 'kL', 3.15],
  ['Pet coke', 'tonne', 3.3],
  ['Limestone', 'tonne', 0.44],
  ['Grid power', 'MWh', 0.71],
];

/** Emission factors are published figures; a wrong one silently misstates a cap. */
const SECTORS = [
  ['Power', 'Coal, gas and nuclear generation'],
  ['Cement', 'Clinker and cement production'],
  ['Steel', 'Integrated steel plants'],
  ['Aluminium', 'Smelters and alumina refineries'],
  ['Fertiliser', 'Ammonia and urea'],
  ['Petrochemicals', 'Olefins and aromatics'],
  ['Pulp & Paper', 'Integrated pulp mills'],
  ['Textile', 'Spinning and processing'],
  ['Chlor-Alkali', 'Chlorine and caustic soda'],
  ['Refinery', 'Oil refining'],
];

const FACILITY_TYPES = [
  'Coal plant', 'Gas plant', 'Cement kiln', 'Steel plant', 'Aluminium smelter',
  'Fertiliser plant', 'Petrochemical unit', 'Pulp mill', 'Spinning mill',
  'Chlor-alkali plant', 'Refinery',
];

const PROJECT_TYPES = ['Solar', 'Wind', 'Reforestation', 'Biogas', 'Cookstoves', 'Afforestation'];

/**
 * Verifiers, including the internal reviewer.
 *
 * The internal reviewer is not a real accreditation body. verification.verifierId
 * is NOT NULL and points here, so an ADMIN — who is not tied to any accredited
 * verifier — needs somewhere honest to attribute a decision. The API falls back to
 * this row only when the acting account has no verifierId of its own, and the
 * audit trail still records the real acting user separately.
 */
const VERIFIERS = [
  ['Bureau Veritas India', 'BV-IN-2019-001'],
  ['TUV SUD Bharat', 'TUV-IN-2020-114'],
  ['SGS India Emissions', 'SGS-IN-2018-077'],
  ['Intertek Testing Services', 'ITS-IN-2021-203'],
  ['CarbonX Internal Review', env.seed.internalVerifierAccNo || 'CX-INTERNAL-0001'],
];

async function seedReference() {
  log('reference data');

  await upsertMany(Country, 'isoCode', [{ name: 'India', isoCode: 'IN' }]);
  const india = await Country.findOne({ isoCode: 'IN' });

  await upsertMany(State, 'name', STATES.map((name) => ({ name, countryId: india._id })));
  const states = await State.find({ countryId: india._id });
  const stateByName = new Map(states.map((s) => [s.name, s._id]));

  await upsertMany(
    City,
    'name',
    CITIES.map(([stateName, name, latitude, longitude]) => ({
      name,
      stateId: stateByName.get(stateName) ?? null,
      stateName,
      countryIso: 'IN',
      latitude,
      longitude,
    })),
  );

  await upsertMany(Sector, 'name', SECTORS.map(([name, description]) => ({ name, description })));
  await upsertMany(FacilityType, 'name', FACILITY_TYPES.map((name) => ({ name })));
  await upsertMany(FuelType, 'name', FUELS.map(([name, unit, emissionFactor]) => ({ name, unit, emissionFactor })));
  await upsertMany(Registry, 'name', ['Verra', 'Gold Standard', 'India CCTS'].map((name) => ({ name })));
  await upsertMany(ProjectType, 'name', PROJECT_TYPES.map((name) => ({ name })));
  await upsertMany(Verifier, 'accreditationNo', VERIFIERS.map(([name, accreditationNo]) => ({ name, accreditationNo })));

  // EmissionSource has no natural unique key in the original schema, so it is
  // keyed on the (scope, name) pair, which is what makes it unique in practice.
  const sources = [
    { scope: 1, name: 'Stationary combustion' },
    { scope: 1, name: 'Process emissions' },
    { scope: 1, name: 'Fugitive emissions' },
    { scope: 2, name: 'Purchased electricity' },
    { scope: 3, name: 'Transport' },
  ];
  for (const source of sources) {
    await EmissionSource.findOneAndUpdate(
      { scope: source.scope, name: source.name },
      { $set: source },
      { upsert: true },
    );
  }

  // Four compliance years, centred on the present so the dashboard has history and
  // the current year is open. Status defaults to OPEN and is not reset here: a
  // closed period is a real state, and re-seeding must not reopen a year that has
  // already been assessed and fined.
  const currentYear = new Date().getUTCFullYear();
  for (const year of [currentYear - 2, currentYear - 1, currentYear, currentYear + 1]) {
    await CompliancePeriod.findOneAndUpdate(
      { year },
      {
        $setOnInsert: {
          year,
          startDate: new Date(Date.UTC(year, 0, 1)),
          endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
          deadline: new Date(Date.UTC(year + 1, 2, 31)),
          status: 'OPEN',
        },
      },
      { upsert: true },
    );
  }

  log(`  ${STATES.length} states, ${CITIES.length} cities, ${SECTORS.length} sectors, ${FUELS.length} fuels`);
}

/** Demo companies, one per sector, with facilities placed at real cities. */
const DEMO_COMPANIES = [
  { name: 'Gujarat Power Ltd', sector: 'Power', city: 'Ahmedabad', facilityType: 'Coal plant', lat: 23.0225, lng: 72.5714, baseline: 480_000, cap: 500_000, reg: 'GJ-PWR-001' },
  { name: 'Sabarmati Cement Ltd', sector: 'Cement', city: 'Kovai', facilityType: 'Cement kiln', lat: 11.0168, lng: 76.9558, baseline: 210_000, cap: 220_000, reg: 'TN-CEM-002' },
  { name: 'Kalinga Steel Ltd', sector: 'Steel', city: 'Rourkela', facilityType: 'Steel plant', lat: 22.2604, lng: 84.8536, baseline: 640_000, cap: 600_000, reg: 'OD-STL-003' },
  { name: 'Konkan Smelters Ltd', sector: 'Aluminium', city: 'Kochi', facilityType: 'Aluminium smelter', lat: 9.9312, lng: 76.2673, baseline: 175_000, cap: 200_000, reg: 'KL-ALU-004' },
  { name: 'Narmada Fertilisers Ltd', sector: 'Fertiliser', city: 'Vadodara', facilityType: 'Fertiliser plant', lat: 22.3072, lng: 73.1812, baseline: 290_000, cap: 280_000, reg: 'GJ-FER-005' },
];

async function seedDemo() {
  log('demo data');

  const sectors = await Sector.find();
  const sectorByName = new Map(sectors.map((s) => [s.name, s._id]));
  const types = await FacilityType.find();
  const typeByName = new Map(types.map((t) => [t.name, t._id]));
  const cities = await City.find();
  const cityByName = new Map(cities.map((c) => [c.name, c._id]));
  const fuels = await FuelType.find();
  const coal = fuels.find((f) => f.name === 'Coal');

  const currentYear = new Date().getUTCFullYear();
  const period = await CompliancePeriod.findOne({ year: currentYear });

  const created = [];

  for (const spec of DEMO_COMPANIES) {
    const company = await Company.findOneAndUpdate(
      { regNumber: spec.reg },
      {
        $set: {
          name: spec.name,
          sectorId: sectorByName.get(spec.sector) ?? null,
          regNumber: spec.reg,
          status: 'ACTIVE',
        },
        $setOnInsert: { email: `${spec.reg.toLowerCase()}@carbonx.local` },
      },
      { upsert: true, new: true },
    );

    const facility = await Facility.findOneAndUpdate(
      { companyId: company._id, name: `${spec.name} — ${spec.city}` },
      {
        $set: {
          companyId: company._id,
          cityId: cityByName.get(spec.city) ?? null,
          facilityTypeId: typeByName.get(spec.facilityType) ?? null,
          name: `${spec.name} — ${spec.city}`,
          latitude: spec.lat,
          longitude: spec.lng,
          baselineAnnualTonnes: spec.baseline,
          capacityMw: Math.round(spec.baseline / 8000),
          commissionedYear: 2012,
          status: 'ACTIVE',
        },
      },
      { upsert: true, new: true },
    );

    // One fuel linkage so the facility detail view has something to show.
    if (coal) {
      await FacilityFuel.findOneAndUpdate(
        { facilityId: facility._id, fuelId: coal._id },
        { $set: { annualConsumption: Math.round(spec.baseline / coal.emissionFactor) } },
        { upsert: true },
      );
    }

    // A sensor per facility, with a known key so the simulator can post to it.
    const serialNo = `SEN-${spec.reg}`;
    await Sensor.findOneAndUpdate(
      { serialNo },
      {
        $set: {
          facilityId: facility._id,
          serialNo,
          sensorType: 'CO2',
          apiKeyHash: hashSensorKey(DEMO_SENSOR_KEY),
          status: 'ONLINE',
        },
      },
      { upsert: true },
    );

    if (period) {
      await EmissionCap.findOneAndUpdate(
        { companyId: company._id, periodId: period._id },
        { $set: { capTonnes: spec.cap }, $setOnInsert: { companyId: company._id, periodId: period._id } },
        { upsert: true },
      );
    }

    created.push({ company, facility });
  }

  // A wallet per company, so /api/wallet has something to read before any credit
  // is issued.
  for (const { company } of created) {
    await credits.ensureAccount(company._id, null);
  }

  log(`  ${created.length} companies, facilities, sensors and caps for ${currentYear}`);
  return created;
}

/** The shared demo sensor key. Not secret, and not for anywhere but a laptop. */
const DEMO_SENSOR_KEY = 'cx_demo_sensor_key_0001';

async function seedUsers() {
  log('demo users');

  const companies = await Company.find().sort({ name: 1 });
  const verifiers = await Verifier.find();
  const internalReviewer = verifiers.find(
    (v) => v.accreditationNo === (env.seed.internalVerifierAccNo || 'CX-INTERNAL-0001'),
  );

  const accounts = [
    { email: env.seed.adminEmail, password: env.seed.adminPassword, fullName: 'Platform Admin', role: 'ADMIN' },
    {
      email: env.seed.auditorEmail,
      password: env.seed.auditorPassword,
      fullName: 'Emission Auditor',
      role: 'AUDITOR',
      // An AUDITOR must be tied to an accredited verifier — the User model rejects
      // one without. The internal reviewer is used here rather than a real body,
      // so no demo decision is attributed to a real accreditation.
      verifierId: internalReviewer?._id ?? null,
    },
    ...companies.slice(0, 2).map((company, i) => ({
      email: i === 0 ? env.seed.companyEmail : `${company.regNumber.toLowerCase()}@carbonx.local`,
      password: env.seed.companyPassword,
      fullName: `${company.name} Operator`,
      role: 'COMPANY',
      companyId: company._id,
    })),
  ];

  for (const account of accounts) {
    if (!account.email || !account.password) {
      log(`  skipping ${account.role}: email or password not configured in .env`);
      continue;
    }
    const passwordHash = await bcrypt.hash(account.password, 10);
    await User.findOneAndUpdate(
      { email: account.email },
      {
        $set: {
          fullName: account.fullName,
          role: account.role,
          companyId: account.companyId ?? null,
          verifierId: account.verifierId ?? null,
          isActive: true,
          // Re-hashed on every run, so changing the .env password takes effect
          // without a manual reset.
          passwordHash,
        },
      },
      { upsert: true },
    );
  }

  log(`  ${accounts.length} accounts`);
  log(`    admin   ${env.seed.adminEmail}`);
  log(`    auditor ${env.seed.auditorEmail}`);
  log(`    company ${env.seed.companyEmail}`);
  log(`  sensor key for the simulator: ${DEMO_SENSOR_KEY}`);
}

/**
 * A year of price history, so the chart has candles on first load rather than
 * starting empty and looking broken.
 *
 * Generated rather than loaded: the original backfilled from whatever trades
 * existed, and a freshly seeded database has none. These are clearly synthetic
 * prices, and the function that does it is the same one the nightly job uses, so
 * a real day overwrites them once there are real trades.
 */
async function seedPriceHistory(days = 90) {
  log(`price history (${days} days)`);
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (days - 1) * 86_400_000);
  const written = await pricing.backfillPriceHistory(from, today);
  log(`  ${written} days`);
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const demo = args.includes('--demo') || reset;

  console.log(`[seed] connecting to ${env.db.appDatabase}`);
  await db.connect({ silent: true });

  const supports = await db.supportsTransactions();
  if (!supports) {
    console.warn(
      '[seed] WARNING: this server is not a replica set, so transactions are unavailable.\n' +
        '        Reference data will seed, but issuing credit batches will fail.',
    );
  }

  if (reset) {
    log('--reset: clearing application collections');
    // Reference data is left alone: it is the same on every run and re-seeding it
    // would only churn the ids that everything else references.
    for (const Model of [Company, User, Facility, FacilityFuel, Sensor, OffsetProject, EmissionCap, Alert]) {
      await Model.deleteMany({});
    }
  }

  await seedReference();
  if (demo) {
    await seedDemo();
    await seedUsers();
  }
  await seedPriceHistory();

  log('done');
  log('');
  log('  Start the API:      npm start');
  log('  Feed some readings: npm run simulate');
}

main()
  .catch((err) => {
    console.error(`\n[seed] FAILED: ${err.message}`);
    if (/not authorized/i.test(err.message)) {
      console.error(
        '  This looks like a permissions problem: run `npm run db:setup` as an\n' +
          '  administrative user before seeding, so carbonx_app exists.',
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
