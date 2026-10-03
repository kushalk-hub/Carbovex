'use strict';

/**
 * Database setup.
 *
 *   npm run db:setup            create the database, indexes and the app role
 *   npm run db:reset            drop everything first, then the above
 *
 * This is the MongoDB replacement for the migration step of the PostgreSQL
 * version, and it does three things:
 *
 *   1. Verifies the server can actually support the application, and says so
 *      plainly if it cannot.
 *   2. Builds every index declared on the models. Uniqueness is a *server-side*
 *      guarantee and does not exist until this has run — the schemas declaring
 *      `unique: true` are only a statement of intent until the index is there.
 *   3. Creates a least-privilege application user whose permissions are what
 *      actually enforce append-only. This is the part with no PostgreSQL
 *      equivalent worth keeping.
 *
 * On (3), because it is the one guarantee that got weaker in the migration.
 * In PostgreSQL, `trg_reading_immutable` and `trg_ledger_no_update` were triggers:
 * they fired for every client, with no way to bypass them short of disabling
 * triggers as a superuser. Here the model-level guards in src/models/helpers.js
 * stop *this application*, but a script or a person with the app's credentials
 * could still update a ledger row directly. Granting the app role insert and find
 * but not update or remove on those two collections moves the guarantee into the
 * database, where a client cannot opt out of it.
 *
 * Run it as an administrative user, not as carbonx_app — a user cannot grant
 * privileges it does not hold.
 */

const mongoose = require('mongoose');
const env = require('../src/config/env');
const models = require('../src/models');

/** Collections whose contents are a permanent record. Insert-only, by grant. */
const APPEND_ONLY = ['creditledger', 'emissionreadings', 'auditlog', 'trades', 'payments', 'verifications'];
/** Collections consumed by src/realtime/changeStream.js. */
const CHANGE_STREAMS = ['trades', 'emissionreadings', 'alerts', 'marketorders'];

/**
 * The database the application actually uses, as a handle on the default
 * connection.
 *
 * The default connection points at the *app* database, never at admin, so every
 * `model.syncIndexes()` lands where the application will look for it. The admin
 * database is reached through `adminConn` instead.
 */
const appDb = () => mongoose.connection.db;

/**
 * Roles from earlier versions of this script, dropped on every run.
 *
 * Kept because a role created by an older version may hold a database-wide grant
 * that the current design deliberately avoids, and MongoDB privileges are
 * additive — such a grant can never be narrowed, only deleted. If one of these is
 * left in place it silently defeats the append-only guarantee, and nothing in
 * the setup output would reveal that.
 */
const STALE_ROLE_PATTERNS = [
  'carbonx_app', // v1: held {db, collection: ''} with find/insert/update/remove
  'carbonx_app_rw', // v2: per-collection, but superseded by carbonx_app_app
];

/** All collections, in dependency-free order, for the drop path. */
const ALL_COLLECTIONS = Object.keys(models)
  .filter((k) => typeof models[k] === 'function' && models[k].schema)
  .map((k) => models[k].collection.name)
  .concat('cctsstaging');

const log = (msg) => console.log(`[setup] ${msg}`);
const warn = (msg) => console.warn(`[setup] ${msg}`);

/**
 * Check the server can support the application before doing anything.
 *
 * A standalone mongod boots fine and serves reads, so nothing fails until the
 * first trade tries to open a transaction. Saying it here, at setup time, is
 * the difference between a clear message and a 500 in production.
 */
async function verifyServer() {
  const admin = mongoose.connection.db.admin();

  const info = await admin.command({ hello: 1 });
  const isReplicaSet = Boolean(info.setName);
  const isMongos = info.msg === 'isdbgrid';

  if (!isReplicaSet && !isMongos) {
    throw new Error(
      'This server is a standalone mongod, which cannot run the multi-document ' +
        'transactions the trading, credit and compliance paths depend on.\n\n' +
        '  Transactions would fail with:\n' +
        '    "Transaction numbers are only allowed on a replica set member or mongos"\n\n' +
        '  Restart mongod with replication enabled and initialise it:\n' +
        '    mongod --replSet rs0 --dbpath <path>\n' +
        '    mongosh --eval "rs.initiate()"\n\n' +
        '  For a throwaway local replica set, `npm run mongo:test-rs` does both.',
    );
  }

  // Change streams are used for cross-process realtime events. They need the
  // same thing transactions do, but their absence is not fatal — realtime falls
  // back to in-process emits — so this is a warning rather than an error.
  let changeStreams = true;
  try {
    const cs = mongoose.connection.db.collection('setup_probe').watch();
    await cs.close();
  } catch {
    changeStreams = false;
  }

  log(`server: ${info.version ?? 'unknown'}, ${isMongos ? 'mongos' : `replica set "${info.setName}"`}`);
  log(`transactions: available`);
  log(`change streams: ${changeStreams ? 'available' : 'UNAVAILABLE (realtime will use local emits only)'}`);

  return { isReplicaSet, isMongos, changeStreams };
}

/**
 * Build every index the models declare.
 *
 * Uses syncIndexes rather than createIndexes, so an index that is no longer
 * declared by any model is dropped. Without that, a renamed or removed index
 * lingers forever and keeps costing write throughput.
 *
 * background is not an option since MongoDB 4.2 — index builds no longer block
 * and the option was removed rather than ignored.
 */
async function buildIndexes({ drop = false } = {}) {
  const conn = mongoose.connection;
  const existing = new Set((await conn.db.listCollections().toArray()).map((c) => c.name));

  for (const collection of ALL_COLLECTIONS) {
    const model = Object.values(models).find(
      (M) => typeof M === 'function' && M.schema && M.collection.name === collection,
    );

    // Create the collection if it does not exist yet.
    //
    // This matters more than it looks. Indexes cannot be created on a collection
    // that does not exist, and MongoDB does not create collections until a
    // document is written. So skipping the absent ones — which the first version
    // of this function did — means most of the unique indexes are simply never
    // built, and the uniqueness they promise does not exist until someone
    // happens to insert a document of that type. A validator-only create is
    // enough: the collection exists, empty, with its indexes.
    if (!existing.has(collection)) {
      try {
        await conn.db.createCollection(collection);
      } catch (err) {
        if (err.codeName !== 'NamespaceExists') {
          warn(`could not create collection ${collection}: ${err.message}`);
          continue;
        }
      }
    }

    try {
      if (drop) await conn.db.collection(collection).dropIndexes();
      if (model) {
        await model.syncIndexes();
      } else if (collection === 'cctsstaging') {
        await conn.db.collection(collection).createIndex(
          { sourceFile: 1, sourceRow: 1 },
          { unique: true, name: 'source_file_row_unique' },
        );
      }
      const idx = await conn.db.collection(collection).indexes();
      const unique = idx.filter((i) => i.unique).map((i) => i.name);
      log(
        `${collection}: ${idx.length} index(es)` +
          (unique.length ? `, ${unique.length} unique` : ''),
      );
    } catch (err) {
      throw new Error(`Failed to build indexes for ${collection}: ${err.message}`);
    }
  }
}

/**
 * Create the least-privilege application user.
 *
 * The grants, and what each one is for:
 *
 *   per-collection update rights   on everything the application legitimately
 *                                  mutates
 *   find + insert only             on APPEND_ONLY — the append-only guarantee,
 *                                  enforced by the database rather than by the
 *                                  model guards
 *   metadata reads only            at database level
 *   no dropDatabase, no createUser the app cannot erase or escalate
 *
 * This is the part with no PostgreSQL equivalent worth keeping. In PostgreSQL,
 * `trg_reading_immutable` and `trg_ledger_no_update` were triggers: they fired
 * for every client, with no way to bypass them short of disabling triggers as a
 * superuser. Here the model-level guards in src/models/helpers.js stop *this
 * application*, but a script or a person with the app's credentials could still
 * update a ledger row directly. The grant below moves the guarantee into the
 * database, where a client cannot opt out of it.
 *
 * THE TRAP, which cost a rewrite of this function and is worth stating plainly:
 * MongoDB privileges are ADDITIVE. A role can only ever add rights, never remove
 * them. So it is impossible to grant readWrite and then take update away from one
 * collection — a second, narrower role does not subtract from the first.
 *
 * An earlier version of this function did exactly that: a database-wide
 * `{ db, collection: '' }` grant of find/insert/update/remove, plus a narrower
 * find/insert role for the append-only collections. The result looked correct —
 * the roles were created and reported as such — and the guarantee was entirely
 * absent, because the database-wide grant already covered creditledger. The only
 * way to find out was to connect as the app user and try to edit a ledger row.
 * scripts/verifyAppendOnly.js does exactly that.
 *
 * The fix is structural: grant nothing at database level except metadata reads,
 * and name every writable collection explicitly.
 */
async function createAppRole({ drop = false } = {}) {
  const admin = mongoose.connection.db.admin();
  const roleName = env.db.appUser;
  const appDb = env.db.appDatabase;

  const collections = (await mongoose.connection.db.listCollections().toArray())
    .map((c) => c.name);

  const role = `${roleName}_app`;

  // Database level: metadata only.
  //
  // `collection: ''` is required by MongoDB's resource syntax — a bare { db } is
  // rejected with "resource pattern must contain 'collection'". And it is safe
  // here despite matching every collection, because what makes a grant dangerous
  // is the *action* list, not the resource: this one grants only listCollections,
  // dbStats, collStats and listIndexes, none of which can read or change a
  // document. Adding find or insert to this entry is exactly the bug the first
  // version of this function had.
  const privileges = [
    {
      resource: { db: appDb, collection: '' },
      actions: ['listCollections', 'listIndexes', 'dbStats', 'collStats'],
    },
  ];

  // Collection level, one entry per collection, with the actions that collection
  // actually needs.
  for (const name of collections) {
    const actions = APPEND_ONLY.includes(name)
      ? ['find', 'insert']
      : ['find', 'insert', 'update', 'remove', 'createIndex', 'listIndexes'];
    // Change streams require both find and changeStream on every watched
    // collection. Keep this collection-scoped: a database-wide find grant would
    // expose unrelated collections and weaken the least-privilege policy.
    if (CHANGE_STREAMS.includes(name)) actions.push('changeStream');
    privileges.push({ resource: { db: appDb, collection: name }, actions });
  }

  // Always recreate rather than conditionally: a role left over from an earlier
  // version of this script may hold database-wide grants that the new definition
  // does not, and because privileges are additive those cannot be removed by
  // updating. Dropping and recreating is the only way to converge.
  try {
    await admin.command({ dropRole: role });
  } catch {
    // Not there yet, which is the normal first-run case.
  }
  await admin.command({ createRole: role, privileges, roles: [] });

  // Remove roles left behind by earlier versions of this script. They are not
  // merely unused: the first version created a role literally named after the
  // user, holding a database-wide find/insert/update/remove grant. Because
  // privileges are additive, that grant cannot be narrowed after the fact — it
  // has to be deleted. Left in place it silently defeats the whole grant design
  // below, which is precisely what happened the first time this ran.
  for (const stale of STALE_ROLE_PATTERNS) {
    if (stale === role) continue; // never drop the role this run just created
    const existing = await admin
      .command({ rolesInfo: stale, showPrivileges: false })
      .then((info) => info.roles?.some((r) => r.role === stale))
      .catch(() => false);
    if (!existing) continue;

    await admin.command({ dropRole: stale });
    warn(`dropped stale role ${stale} from an earlier version of this script`);
  }

  const appendOnlyCount = collections.filter((c) => APPEND_ONLY.includes(c)).length;
  log(
    `created role ${role}: ${collections.length - appendOnlyCount} collection(s) read-write, ` +
      `${appendOnlyCount} append-only (find+insert only)`,
  );

  if (collections.length === 0) {
    warn('no collections exist yet, so the role grants metadata access only.');
    warn('Run `npm run db:setup` again after seeding to grant collection access.');
  }

  // Recreate the user too, for the same additive-privileges reason: updating a
  // user's roles does not remove privileges inherited from roles it is being
  // detached from.
  try {
    await admin.command({ dropUser: roleName });
    if (drop) warn(`dropped and recreated user ${roleName}`);
  } catch {
    // Absent, so it gets created below.
  }

  try {
    await admin.command({
      createUser: roleName,
      pwd: env.db.appPassword,
      roles: [role],
    });
    log(`created user ${roleName} (password from DB_PASSWORD)`);
  } catch (err) {
    throw new Error(`Could not create user ${roleName}: ${err.message}`);
  }
}

/**
 * Rewrite the admin URI so it selects a particular database.
 *
 * This exists because of a real bug. `mongodb://host:27017/?authSource=admin`
 * has an empty path, so the driver falls back to `test` as the default database.
 * The original version of this script connected that URI and then used
 * `mongoose.connection.db` for everything — meaning the 33 collections and their
 * indexes were created in `test`, the grants were made against `test`, and
 * `--reset` dropped `test`. The application, which reads DB_NAME=carbonx, saw an
 * empty database. Nothing errored; the setup just did its work in the wrong place.
 *
 * Keeping the credentials and query string from the configured URI and only
 * substituting the path is deliberately minimal — it also preserves
 * `authSource` and `replicaSet`, both of which are required to work at all.
 */
function adminUriFor(dbName) {
  const base = env.db.adminUri.replace(/\/(\?|$)/, '/$1');
  return base.replace(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*(\?.*)?$/, `$1/${dbName}$2`);
}

async function main() {
  const drop = process.argv.includes('--reset');

  console.log(`[setup] connecting as an administrative user to ${redact(env.db.adminUri)}`);
  try {
    // The default connection is pointed at the *app* database, not admin, so
    // model.syncIndexes() creates the indexes where the application will look
    // for them. Admin commands do not care which database the connection is
    // bound to, so they are issued through this same connection.
    await mongoose.connect(adminUriFor(env.db.appDatabase), { serverSelectionTimeoutMS: 10_000 });
  } catch (err) {
    console.error(
      `[setup] Could not connect: ${err.message}\n\n` +
        '  MONGO_ADMIN_URI must point at a user that can create databases, roles and users.\n' +
        '  On a fresh local install with no authentication, set:\n' +
        '    MONGO_ADMIN_URI=mongodb://localhost:27017/?authSource=admin\n' +
        '    MONGO_URI=mongodb://localhost:27018/carbonx?replicaSet=rs0',
    );
    process.exit(1);
  }

  // Guard against the failure this script already had once: if the default
  // database is not the one the application was configured to use, every
  // collection below is created somewhere nobody will ever read.
  if (mongoose.connection.name !== env.db.appDatabase) {
    console.error(
      `[setup] Connected to database "${mongoose.connection.name}" but DB_NAME is ` +
        `"${env.db.appDatabase}". Refusing to continue, because the indexes and ` +
        'grants would be created in the wrong place.',
    );
    process.exit(1);
  }

  log(`app database: ${env.db.appDatabase}`);

  if (drop) {
    warn('--reset: dropping the app database');
    try {
      await mongoose.connection.db.dropDatabase();
    } catch (err) {
      warn(`could not drop database: ${err.message}`);
    }
  }

  const server = await verifyServer();

  // Touch each model so its indexes are registered, then build them.
  await buildIndexes({ drop });

  await createAppRole({ drop });

  log('');
  log('Setup complete.');
  log(`  Connect the app with: MONGO_URI=${redact(buildAppUri())}`);
  if (!server.changeStreams) {
    log('');
    warn('Change streams are unavailable. Cross-process realtime events will not');
    warn('be delivered; in-process events still are. The API is otherwise correct.');
  }
  log('');
  log('Next: npm run db:seed');
}

function buildAppUri() {
  return (
    `mongodb://${env.db.appUser}:***@${new URL(env.db.adminUri).hostname}:` +
    `${env.db.adminUri.match(/:(\d+)/)?.[1] ?? 27017}/${env.db.appDatabase}?authSource=admin`
  );
}

function redact(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

main()
  .catch((err) => {
    console.error(`\n[setup] FAILED: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
