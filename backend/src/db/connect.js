'use strict';

/**
 * MongoDB connection, session helpers, and the actor context that replaced
 * LISTEN/NOTIFY and the audit trigger.
 *
 * Three things live here that used to live in db/pool.js:
 *
 *   connect()      — one shared mongoose connection
 *   withTransaction(fn) — runs fn inside a multi-document transaction, so a
 *                     half-finished trade still rolls back
 *   asUser(id, fn) — runs fn with `id` recorded as the acting user
 *
 * The actor context is the important one. In PostgreSQL the audit trigger read
 * `current_setting('app.user_id')` to attribute a change to whoever asked for
 * it. MongoDB has no session-local variables, so the equivalent is
 * AsyncLocalStorage, which propagates across await boundaries and is genuinely
 * per-request.
 *
 * The obvious alternative — a module-scoped `let actor` saved and restored
 * around the call — is wrong, and wrong in a way that only shows up under load.
 * Node is single-threaded, but a request suspends at every `await`, so two
 * overlapping requests interleave: A sets actor, awaits a query, B sets actor,
 * A resumes and writes its audit rows under B's name. Every attribution is
 * silently wrong while nothing looks broken. AsyncLocalStorage scopes the value
 * to the async execution context instead, so interleaved requests cannot see
 * each other's.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const mongoose = require('mongoose');
const env = require('../config/env');
const { errors } = require('../middleware/errors');

let connected = false;

/** Per-request actor storage. See the note above before replacing this. */
const actorStorage = new AsyncLocalStorage();

async function connect({ silent = false } = {}) {
  if (connected) return mongoose.connection;

  mongoose.set('strictQuery', true);
  // Fail fast on an unknown field name instead of silently dropping it from the
  // filter — the single most common cause of "why is my query returning
  // everything" in Mongoose.
  //
  // sanitizeFilter is deliberately NOT enabled. It is documented as protection
  // against query-selector injection, but it achieves that by wrapping any object
  // value in a filter in $eq. That is incompatible with ordinary MongoDB
  // querying, and it was found the hard way: with it on, every operator in the
  // application throws a CastError, because the path is cast against the
  // operator object rather than against the intended value.
  //
  //   findOne({ creditBalance: { $gte: -100 } })
  //     -> Cast to Number failed for value "{ '$gte': -100 }" at path "creditBalance"
  //   findOne({ endDate: { $gte: someDate } })
  //     -> Cast to date failed for value "{ '$gte': ... }" at path "endDate"
  //   findOne({ $expr: ... })
  //     -> $expr is not allowed with sanitizeFilter
  //
  // That is every date-range query, every balance guard, and the conditional
  // claim that stops an order being over-filled. The protection it offers is
  // also the wrong tool for this codebase: the actual defence against an
  // operator arriving from a request is validating the request, which
  // middleware/validate.js does with Zod before any query is built. No user
  // input is ever concatenated into a filter here.
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', false);

  try {
    await mongoose.connect(env.db.uri, {
      maxPoolSize: env.db.maxPoolSize,
      minPoolSize: env.db.minPoolSize,
      serverSelectionTimeoutMS: env.db.serverSelectionTimeoutMS,
      socketTimeoutMS: env.db.socketTimeoutMS,
      maxIdleTimeMS: env.db.maxIdleTimeMS,
      ...(env.db.replicaSet ? { replicaSet: env.db.replicaSet } : {}),
    });
  } catch (err) {
    throw new Error(
      `Could not connect to MongoDB at ${redact(env.db.uri)}: ${err.message}. ` +
        'Is mongod running, and is MONGO_URI correct?',
    );
  }

  connected = true;
  if (!silent) {
    console.log(`[db] connected to ${redact(env.db.uri)}`);
  }
  return mongoose.connection;
}

function redact(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

/**
 * True when the server can run multi-document transactions.
 *
 * Requires a replica set or sharded cluster. A standalone mongod reports
 * "Transaction numbers are only allowed on a replica set member", so this is
 * checked once at boot rather than being discovered inside the first trade.
 */
async function supportsTransactions() {
  try {
    const admin = mongoose.connection.db.admin();
    const info = await admin.command({ hello: 1 });
    return Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    return false;
  }
}

/**
 * Run fn inside a transaction, retrying once on the transient conflicts that are
 * normal under concurrent trading.
 *
 * `withTransaction` on the driver session already retries TransientTransaction-
 * Error and UnknownTransactionCommitResult, which is exactly the behaviour we
 * want. The guard below is for the case where the server does not support
 * transactions at all: rather than failing every trade, it says so plainly.
 */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (/Transaction numbers are only allowed|replica set member or mongos/.test(err.message)) {
      throw errors.conflict(
        'This operation needs a replica set. Start mongod with --replSet and run ' +
          '`npm run db:setup` to initialise it.',
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Run fn as a specific user, so anything it writes is attributed to them.
 *
 * The audit records need this: a bare `updateOne` carries no idea who asked.
 * `session.actorId` is read by services/audit.js.
 */
function asUser(userId, fn) {
  return actorStorage.run({ userId: userId ?? null }, fn);
}

/** The acting user for the current operation, or null. */
function currentActorId() {
  const store = actorStorage.getStore();
  return store ? store.userId : null;
}

/** True when the server is a replica set / cluster, so change streams work. */
async function supportsChangeStreams() {
  return supportsTransactions();
}

async function close() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

module.exports = {
  connect,
  close,
  isConnected,
  supportsTransactions,
  supportsChangeStreams,
  withTransaction,
  asUser,
  currentActorId,
  mongoose,
};
