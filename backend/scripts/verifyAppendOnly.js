'use strict';

/**
 * Verifies the append-only guarantee holds at the DATABASE level, not just in
 * the application.
 *
 * This is the check that matters most for the PostgreSQL -> MongoDB move. The
 * model-level guards in src/models/helpers.js stop this API from editing a ledger
 * row, but in PostgreSQL the equivalent triggers stopped *everyone*. The
 * replacement is a least-privilege role, and a grant that was never tested is a
 * grant that does not work.
 *
 * Run as the app user, not as an administrator.
 *
 *   MONGO_URI=mongodb://carbonx_app:carbonx_app@localhost:27018/carbonx?replicaSet=rs0&authSource=admin
 *   npm run db:verify-append-only
 */

const mongoose = require('mongoose');
const env = require('../src/config/env');

/**
 * Must match the list in setup.js. Kept as a literal here rather than imported
 * on purpose: this script is a check *on* setup.js, and importing the constant
 * would mean a mistake in setup.js silently made the test agree with it.
 */
const APPEND_ONLY = [
  'creditledger',
  'emissionreadings',
  'auditlog',
  'trades',
  'payments',
  'verifications',
];

const log = (m) => console.log(`  ${m}`);

async function main() {
  console.log('[append-only] connecting as the application user');
  await mongoose.connect(env.db.uri, { serverSelectionTimeoutMS: 10_000 });
  log(`connected to ${env.db.appDatabase}`);

  const db = mongoose.connection.db;
  let failures = 0;

  const check = async (label, collectionName, fn, expectDenied) => {
    const collection = db.collection(collectionName);
    try {
      await fn(collection);
      if (expectDenied) {
        console.error(`  FAIL  ${label}: the operation was ALLOWED but should be denied`);
        failures += 1;
        return false;
      }
      log(`ok   ${label}: allowed, as expected`);
      return true;
    } catch (err) {
      if (!expectDenied) {
        console.error(`  FAIL  ${label}: denied unexpectedly — ${err.message}`);
        failures += 1;
        return false;
      }
      // "not authorized" is the whole point, so this is the success case.
      const expected = /not authorized|no permissions|requires authentication/i.test(err.message);
      if (!expected) {
        console.error(`  FAIL  ${label}: denied for the wrong reason — ${err.message}`);
        failures += 1;
        return false;
      }
      log(`ok   ${label}: denied by the database (${err.codeName})`);
      return true;
    }
  };

  // Every insert-only collection, tested the same way. The list is exhaustive on
  // purpose: a grant that was never exercised is a grant that does not work, and
  // the first version of this script only checked the ledger and the readings,
  // which left the audit trail — the one collection where an edit is hardest to
  // detect afterwards — unverified.
  const probes = [];

  for (const name of APPEND_ONLY) {
    console.log('');
    console.log(`${name} — must be insert-only:`);

    // Insertion must be permitted. Doing it first is what makes the denials
    // below meaningful rather than the symptom of a user that can do nothing.
    const probe = { _id: new mongoose.Types.ObjectId(), probe: true, quantity: 1 };
    await db.collection(name).insertOne(probe);
    probes.push({ name, _id: probe._id });
    log('insert: allowed (a permanent record must be writable)');

    await check(
      'update',
      name,
      (c) => c.updateOne({ _id: probe._id }, { $set: { quantity: 999 } }),
      true,
    );
    await check('delete', name, (c) => c.deleteOne({ _id: probe._id }), true);
    await check(
      'replace',
      name,
      (c) => c.replaceOne({ _id: probe._id }, { probe: true }),
      true,
    );
    await check('find (read)', name, (c) => c.findOne({ _id: probe._id }), false);
  }

  // A non-append-only collection must still be writable, or the application
  // cannot function at all. Checking this is what makes the denial results above
  // meaningful rather than the symptom of a misconfigured user.
  console.log('');
  console.log('marketorders — must be fully writable:');
  const order = { _id: new mongoose.Types.ObjectId(), side: 'BUY', quantity: 1, pricePerCredit: 1 };
  await check('insert', 'marketorders', (c) => c.insertOne(order), false);
  await check(
    'update',
    'marketorders',
    (c) => c.updateOne({ _id: order._id }, { $set: { quantity: 2 } }),
    false,
  );
  await check('delete', 'marketorders', (c) => c.deleteOne({ _id: order._id }), false);

  // Clean up as an admin, since the app user cannot delete from the
  // append-only collections — which is precisely the point.
  //
  // The app database is named explicitly. adminUri usually has an empty path, so
  // connecting to it as-is lands on `test` and deletes nothing, leaving probe rows
  // behind that later confuse an index count or a seed run.
  await mongoose.disconnect();
  const adminUri = env.db.adminUri.replace(
    /^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*(\?.*)?$/,
    `$1/${env.db.appDatabase}$2`,
  );
  const admin = await mongoose.createConnection(adminUri).asPromise();
  for (const { name, _id } of probes) {
    await admin.db.collection(name).deleteOne({ _id });
  }
  await admin.close();
  log(`cleaned up ${probes.length} probe row(s)`);

  console.log('');
  if (failures > 0) {
    console.error(`[append-only] ${failures} check(s) FAILED — the guarantee is not in place.`);
    console.error('  Re-run `npm run db:setup` as an administrative user.');
    process.exitCode = 1;
    return;
  }
  console.log('[append-only] all checks passed: the database refuses to update, replace or');
  console.log('  delete the ledger, readings, audit trail, trades, payments and verifications,');
  console.log('  independently of the model-level guards.');
}

main().catch((err) => {
  console.error(`[append-only] FAILED: ${err.message}`);
  process.exitCode = 1;
});
