'use strict';

/**
 * Shared model helpers.
 *
 * Two things here replace behaviour that PostgreSQL gave for free.
 *
 * 1. ValidationError -> AppError. A Mongoose ValidationError is a 500 by
 *    default, which is wrong: a POST with a negative quantity is the caller's
 *    fault and must be a 400 with a usable message. Every route validates with
 *    Zod first, so this is the second line of defence, not the first.
 *
 * 2. transaction(fn). MongoDB's withTransaction is the correct primitive but it
 *    is noisy to call and easy to forget to pass the session to every query.
 *    This wrapper makes "forget the session" harder: it hands you a session and
 *    you must pass it explicitly, but the retry behaviour is handled for you.
 */

const mongoose = require('mongoose');
const { errors } = require('../middleware/errors');
const { withTransaction } = require('../db/connect');

/** Convert a Mongoose ValidationError into a 400 the caller can act on. */
function translateValidationError(err) {
  if (!(err instanceof mongoose.Error.ValidationError)) return err;

  const details = {};
  for (const [field, e] of Object.entries(err.errors)) {
    details[field] = e.message;
  }
  return errors.badRequest('Validation failed', details);
}

/** Run fn with a fresh session, wrapping MongoDB's write-conflict retry. */
function transaction(fn) {
  return withTransaction(fn);
}

/**
 * A field that references another document.
 *
 * MongoDB has no foreign keys, so referential integrity is unenforced. That is
 * the biggest correctness cost of this rewrite and it is not optional to think
 * about: a facility can be deleted while readings still point at it, and nothing
 * will complain. The two mitigations actually used are:
 *
 *   - services/credits.js and services/trading.js re-read every referenced
 *     document inside the transaction and throw if it is missing, so an order
 *     can never be placed against a batch that has gone.
 *   - scripts/setup.js grants the app role `delete` on nothing, so deletes have
 *     to be done deliberately.
 */
const ref = (modelName, options = {}) => {
  const fallback = options.default === undefined ? null : options.default;
  return {
    type: mongoose.Schema.Types.ObjectId,
    ref: modelName,
    required: Boolean(options.required),
    default: fallback,
  };
};

/** A non-negative amount of money or credits. */
const nonNegative = {
  type: Number,
  min: 0,
};

/** A strictly positive amount. */
const positive = {
  type: Number,
  min: Number.MIN_VALUE,
};

/**
 * Date field defaulting to now.
 *
 * Note the asymmetry with the SQL: Postgres stored TIMESTAMPTZ and compared
 * against `now()`. MongoDB stores BSON dates, which are UTC milliseconds, so
 * there is no timezone to get wrong — but $dateTrunc works in UTC too, so any
 * "year" boundary in this system is a UTC year.
 */
const nowDate = { type: Date, default: Date.now };

/**
 * Reject a document update or delete.
 *
 * This is the replacement for the append-only triggers on credit_ledger and
 * emission_reading. It is a real guard, but it is an *application-level* guard:
 * it stops this API, and nothing else. The database-level half of the guarantee
 * is the carbonx_app role, which has no update or delete rights on these
 * collections. See legacy-postgres/README.md.
 */
function appendOnly(schema, collectionName) {
  const deny = function (next) {
    next(
      new Error(
        `${collectionName} is append-only: entries may be inserted, never modified or removed. ` +
          'Record a correcting entry instead.',
      ),
    );
  };

  schema.pre('updateOne', deny);
  schema.pre('updateMany', deny);
  schema.pre('findOneAndUpdate', deny);
  schema.pre('replaceOne', deny);
  schema.pre('deleteOne', deny);
  schema.pre('deleteMany', deny);
  schema.pre('findOneAndDelete', deny);

  return schema;
}

/**
 * Register a document-level validator — the replacement for a SQL CHECK
 * constraint that spans more than one column.
 *
 * The signature is `check(schema, field, rule)`:
 *   field  the path to blame when the rule fails, so the 400 response names the
 *          offending field rather than saying "validation failed" at the document
 *   rule   (doc) => true, or a string explaining the failure
 *
 * Note the two traps this helper exists to avoid, both of which fail silently:
 *
 *   1. `new Schema(paths, { validate: fn })` does NOT register a document
 *      validator. `validate` is not a recognised entry in the options bag, so
 *      Mongoose discards it and the constraint quietly does nothing.
 *   2. There is no `schema.validate(fn)` in Mongoose 8 either — document-level
 *      validation is a `pre('validate')` hook that calls `this.invalidate(path,
 *      message)`. `SchemaType.prototype.validate` exists but is path-level and
 *      cannot see sibling fields, which is exactly what a CHECK constraint needs.
 */
function check(schema, field, rule) {
  schema.pre('validate', function crossFieldCheck(next) {
    const verdict = rule(this);
    if (verdict !== true) {
      this.invalidate(field, typeof verdict === 'string' ? verdict : 'invalid value');
    }
    next();
  });
  return schema;
}

/** Shared options for every schema: no `id`, and versionKey is unused. */
const base = { versionKey: false, minimize: false };

module.exports = {
  translateValidationError,
  transaction,
  ref,
  nonNegative,
  positive,
  nowDate,
  appendOnly,
  check,
  base,
};
