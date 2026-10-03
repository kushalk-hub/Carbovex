'use strict';

/**
 * Shaping helpers shared by the route modules.
 *
 * Every collection in this system is addressed by an ObjectId internally and
 * exposed to the client as a string, and every model field is camelCase while
 * the API has always used a mix of snake_case and camelCase. Both translations
 * happen here so they are made once.
 *
 * The reason this file exists rather than ad-hoc `.lean()` calls in each route:
 * the first draft of the auth rewrite returned raw Mongoose documents and got the
 * field names wrong in three separate places, because the model's `fullName` and
 * the API's `full_name` differ and nothing enforces that. Centralising it makes
 * the translation a thing you can test instead of a thing you have to remember.
 */

const mongoose = require('mongoose');

/** ObjectId -> string, and leaves null/undefined alone. */
function id(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
  return value;
}

/** Wrap a single document. Returns null rather than undefined, for JSON stability. */
function one(doc, project) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return project ? pick(plain, project) : plain;
}

/** Wrap a list of documents. */
function many(docs, project) {
  if (!docs || docs.length === 0) return [];
  return docs.map((doc) => {
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return project ? pick(plain, project) : plain;
  });
}

/**
 * Keep only the named fields.
 *
 * A projection, not a delete loop, so this is safe on a Mongoose document without
 * mutating it.
 */
function pick(obj, fields) {
  if (!obj) return obj;
  const out = {};
  for (const field of fields) {
    if (field in obj) out[field] = obj[field];
  }
  return out;
}

/**
 * A paginated list envelope.
 *
 * Every list endpoint returns this shape, so the frontend can rely on it without
 * special-casing. `page` is 1-based, matching the query parameter.
 */
function page(items, { total = null, limit = 50, page: pageNo = 1 } = {}) {
  const size = Number(limit) || 50;
  const current = Math.max(Number(pageNo) || 1, 1);
  return {
    items,
    pagination: {
      page: current,
      limit: size,
      // Total is only known when the caller counted. Omitting it is better than
      // reporting a wrong one, so it stays null rather than being guessed.
      total,
      pages: total === null ? null : Math.max(Math.ceil(total / size), 1),
    },
  };
}

/** Parse a bounded integer from a query string, with a default. */
function intParam(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Parse a date from a query string.
 *
 * Returns null when absent or unparseable, and the caller decides whether that
 * is a 400. Being lenient here and strict at the call site keeps the error
 * message in the place that knows the parameter name.
 */
function dateParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Apply company scoping unless the caller is allowed across companies.
 *
 * COMPANY users are always forced to their own company — this is a
 * defence-in-depth check, not the primary one, since requireCompany in
 * middleware/auth.js has already refused a mismatched target. It exists because
 * a route that forgets the middleware should still not leak another company's
 * rows.
 */
function scopeToCompany(filter, req) {
  if (req.user?.role === 'COMPANY' && req.companyId) {
    return { ...filter, companyId: req.companyId };
  }
  return filter;
}

/**
 * Rename snake_case keys to camelCase, recursively.
 *
 * A leftover from the PostgreSQL era, kept for one reason: the audit trail stores
 * whatever shape a document had when it was written, and rows written before the
 * migration — or written by a script that used raw driver naming — still have
 * snake_case keys. The API contract is camelCase, so the audit view normalises
 * them on the way out.
 *
 * Generic rather than a hand-written list per collection, because audit documents
 * can be arbitrarily deep and a list would fall behind on day two.
 */
function camelise(value) {
  if (Array.isArray(value)) return value.map(camelise);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelCaseKey(k)] = camelise(v);
    }
    return out;
  }
  return value;
}

/** snake_case -> camelCase for a single key. */
function camelCaseKey(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * The keys that differ between two documents, with before and after.
 *
 * A diff rather than two blobs, because "which field actually changed" is the
 * only question anyone opens an audit log to answer.
 *
 * A key present in one document and absent in the other is reported as a change
 * to/from null, which is what makes a column addition or removal visible.
 * Comparison is by JSON serialisation, which is right for the scalar and nested
 * values stored in old_data/new_data and wrong for key order — but Mongoose and
 * the SQL driver both produce a stable key order, so the two agree.
 */
function diffKeys(before, after) {
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const k of keys) {
    const av = a[k] === undefined ? null : a[k];
    const bv = b[k] === undefined ? null : b[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out[camelCaseKey(k)] = { from: av, to: bv };
    }
  }
  return out;
}

module.exports = {
  id,
  one,
  many,
  pick,
  page,
  intParam,
  dateParam,
  scopeToCompany,
  camelise,
  camelCaseKey,
  diffKeys,
};
