'use strict';

/**
 * The audit trail — the replacement for the generic AFTER trigger that wrote
 * audit_log for eleven tables in PostgreSQL.
 *
 * This is the biggest behavioural regression in the whole migration, so it is
 * worth being blunt about it.
 *
 * In Postgres, `CREATE TRIGGER trg_audit ... AFTER INSERT OR UPDATE OR DELETE`
 * meant *every* write was logged, including ones made by a psql session, a
 * migration script, or a bug in a cron job. You could not forget to log, because
 * logging was not a decision anyone made.
 *
 * Here it is a function call. A write that forgets `record()` leaves no trace,
 * and nothing will report that. There is no way to get trigger semantics from
 * MongoDB, so the mitigation is structural instead:
 *
 *   - services only mutate through the small set of functions in this file
 *   - the emission, credit and market services all call record() themselves
 *   - tests/audit.test.js asserts a row exists after each of those paths
 *
 * If you add a write path, add a record() call to it. `assertAudited()` below
 * exists to make that checkable in a test.
 */

const { AuditLog } = require('../models');
const { currentActorId } = require('../db/connect');
const { translateValidationError } = require('../models/helpers');

/** Tables whose writes are logged. Kept explicit so a new table is a visible decision. */
const AUDITED_TABLES = new Set([
  'companies',
  'users',
  'facilities',
  'sensors',
  'emissionreadings',
  'emissioncaps',
  'emissionreports',
  'verifications',
  'offsetprojects',
  'creditbatches',
  'creditledger',
  'creditretirements',
  'marketorders',
  'trades',
  'payments',
  'alerts',
  'penalties',
]);

/** Row identity, as a string, for a possibly-unsaved document. */
function rowPk(doc) {
  if (!doc) return null;
  if (doc._id) return String(doc._id);
  return null;
}

/** A plain object of the fields worth keeping, with ObjectIds rendered as strings. */
function snapshot(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.__v;
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && typeof value.toHexString === 'function') {
      obj[key] = value.toHexString();
    }
  }
  return obj;
}

/**
 * Record one change.
 *
 * Never throws on the caller's behalf: a failure to write an audit row must not
 * roll back a legitimate trade. That is a deliberate choice and it is the one
 * place where this file diverges from the trigger, which would have failed the
 * whole transaction. The trade-off: an audit write can fail silently, so the
 * error is logged loudly.
 */
async function record(tableName, operation, { oldDoc = null, newDoc = null, session = null } = {}) {
  if (!AUDITED_TABLES.has(tableName)) {
    // Logging an unaudited table is almost always a typo in a service call.
    console.warn(`[audit] unknown table "${tableName}"; not logged`);
    return null;
  }

  try {
    const [created] = await AuditLog.create(
      [
        {
          tableName,
          operation,
          rowPk: rowPk(newDoc) || rowPk(oldDoc),
          oldData: snapshot(oldDoc),
          newData: snapshot(newDoc),
          // Falls back to null for system writes (jobs, scripts), which is
          // correct: no user asked for them.
          changedBy: currentActorId(),
          changedAt: new Date(),
        },
      ],
      { session, ordered: true },
    );
    return created;
  } catch (err) {
    const failure = translateValidationError(err);
    console.error(
      `[audit] FAILED to log ${operation} on ${tableName}:`,
      failure.message,
      failure === err ? err.stack : '',
    );
    return null;
  }
}

const inserted = (table, newDoc, session) => record(table, 'INSERT', { newDoc, session });
const updated = (table, oldDoc, newDoc, session) => record(table, 'UPDATE', { oldDoc, newDoc, session });
const removed = (table, oldDoc, session) => record(table, 'DELETE', { oldDoc, session });

/**
 * Reusable mutation wrappers.
 *
 * These exist so the "did you remember to log it" problem has a structural
 * answer: services call applyUpdate/applyDelete rather than the Mongoose methods
 * directly, and logging is not a separate step that can be forgotten.
 */
async function applyInsert(model, table, doc, { session = null } = {}) {
  const [created] = await model.create([doc], { session });
  await inserted(table, created, session);
  return created;
}

async function applyUpdate(model, table, filter, update, options = {}) {
  const { session = null } = options;
  const oldDoc = await model.findOne(filter).session(session).lean();
  const result = await model.findOneAndUpdate(filter, update, { ...options, new: true, session });
  if (result) await updated(table, oldDoc, result, session);
  return result;
}

async function applyDelete(model, table, filter, options = {}) {
  const { session = null } = options;
  const oldDoc = await model.findOne(filter).session(session).lean();
  const result = await model.findOneAndDelete(filter, { ...options, session });
  if (result) await removed(table, result, session);
  return result;
}

/**
 * Assert that a table has an audit row for a given primary key.
 *
 * Not called in production. Exported for tests, because the honest way to
 * compensate for losing trigger semantics is to assert the guarantee still holds
 * on every path that matters.
 */
async function hasAuditFor(tableName, pk, { operation = null, session = null } = {}) {
  const query = { tableName, rowPk: String(pk) };
  if (operation) query.operation = operation;
  return Boolean(await AuditLog.exists(query).session(session));
}

module.exports = {
  AUDITED_TABLES,
  record,
  inserted,
  updated,
  removed,
  applyInsert,
  applyUpdate,
  applyDelete,
  hasAuditFor,
  rowPk,
};
