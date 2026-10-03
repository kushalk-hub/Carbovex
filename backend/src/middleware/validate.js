'use strict';

/**
 * Request validation with zod.
 *
 * The rule this enforces: parse the input, throw on failure, then use the
 * *parsed* value. Reading req.body after validation without using the parsed
 * result is how a "required string" quietly arrives as the string "undefined".
 */

const { z } = require('zod');
const { errors } = require('./errors');

/** Build middleware that validates one part of the request. */
function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || part}: ${i.message}`)
        .join('; ');
      return next(errors.badRequest(detail));
    }
    // Replace the raw value so downstream handlers can only see validated data.
    if (part === 'query') {
      // req.query is a getter on Express 5 and read-only in some setups.
      Object.defineProperty(req, 'validatedQuery', { value: result.data, writable: true });
    } else {
      req[part] = result.data;
    }
    return next();
  };
}

/** Read validated query params, falling back to the raw ones. */
function q(req) {
  return req.validatedQuery || req.query;
}

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/**
 * A record identifier: a 24-character hex ObjectId.
 *
 * This was `z.coerce.number().int().positive()` when the keys were Postgres
 * BIGINTs, and the change matters more than it looks. The 8-byte integer ids are
 * gone, so a numeric schema would reject every valid id, and — worse — accepting
 * small integers would let `/api/facilities/1` through to a query that then
 * fails a BSON cast and returns a 500 instead of a 400.
 *
 * The hex length check is deliberate rather than relying on ObjectId.isValid
 * alone: isValid also accepts any 12-character string, including "hello world",
 * which would sail through validation and fail downstream.
 */
const objectId = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex ObjectId');

/** Optional ObjectId: absent or explicitly null, both meaning "not specified". */
const optionalObjectId = objectId.nullish().transform((v) => (v === undefined ? null : v));

// Kept as a name because many schemas read `id` and the meaning is the same.
const id = objectId;
const year = z.coerce.number().int().min(2000).max(2100);
const tonnes = z.coerce.number().nonnegative().finite();
const money = z.coerce.number().nonnegative().finite();
const price = z.coerce.number().positive().finite();
const role = z.enum(['COMPANY', 'AUDITOR', 'ADMIN']);

/**
 * A real calendar date in YYYY-MM-DD.
 *
 * The round-trip check is necessary: Date.parse('2026-02-30') happily returns
 * 2 March, so a regex alone would let an impossible date through and the
 * database would either reject it or, worse, store a shifted one.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine((s) => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}, 'is not a real date');

const pagination = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const schemas = {
  // --- auth ---------------------------------------------------------------
  login: z.object({
    email: z.string().trim().toLowerCase().email('must be a valid email address'),
    password: z.string().min(1, 'is required'),
  }),

  // --- readings (sensor ingest) -------------------------------------------
  ingest: z.object({
    sensorId: objectId,
    readings: z
      .array(
        z.object({
          ts: z.union([z.string(), z.number()]).transform((v) => new Date(v)),
          tonnes: z.coerce.number().nonnegative().finite(),
          verified: z.boolean().optional(),
        }),
      )
      .min(1, 'must contain at least one reading')
      .max(1000, 'batch is limited to 1000 readings per request'),
  }),

  // --- market -------------------------------------------------------------
  placeOrder: z.object({
    side: z.enum(['BUY', 'SELL']),
    price: price,
    quantity: z.coerce.number().positive().finite(),
  }),

  orderQuery: z.object({
    ...pagination,
    status: z.enum(['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED']).optional(),
    side: z.enum(['BUY', 'SELL']).optional(),
  }),

  depthQuery: z.object({
    levels: z.coerce.number().int().min(1).max(50).default(20),
  }),

  tradesQuery: z.object({ ...pagination }),
  pricesQuery: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    days: z.coerce.number().int().min(1).max(1095).optional(),
  }),
  facilityQuery: z.object({
    year: year.optional(),
    sector: z.string().trim().min(1).max(80).optional(),
    state: z.string().trim().min(1).max(80).optional(),
    search: z.string().trim().min(1).max(120).optional(),
    onlyOverCap: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),
  readingsQuery: z.object({
    bucket: z.enum(['hour', 'day', 'week', 'month']).default('day'),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
  }),

  // --- wallet -------------------------------------------------------------
  retire: z.object({
    quantity: z.coerce.number().positive().finite(),
    // Optional: when omitted the route retires against the current open period.
    // nullish, not just optional, so an explicit `null` from a JSON client is
    // treated as "use the default" rather than failing validation.
    periodId: optionalObjectId,
  }),
  ledgerQuery: z.object({ ...pagination }),

  // --- reports ------------------------------------------------------------
  submitReport: z.object({
    periodId: objectId,
    totalTonnes: tonnes,
  }),
  verifyReport: z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    remarks: z.string().trim().min(1, 'are required when approving or rejecting').max(2000),
  }),

  // --- admin --------------------------------------------------------------
  setCaps: z.object({
    periodId: objectId,
    caps: z
      .array(z.object({ companyId: objectId, capTonnes: money.positive() }))
      .min(1, 'at least one cap is required')
      .max(1000),
  }),
  issueBatch: z.object({
    vintage: year,
    quantity: z.coerce.number().positive().finite(),
    expiryYear: year.nullable().optional(),
  }),

  // --- alerts -------------------------------------------------------------
  alertQuery: z.object({
    ...pagination,
    unreadOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  }),

  // --- misc ---------------------------------------------------------------
  complianceQuery: z.object({ year: year.optional() }),
  auditQuery: z.object({
    ...pagination,
    table: z.string().trim().max(60).optional(),
  }),
  companyQuery: z.object({
    search: z.string().trim().max(120).optional(),
    sector: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
};

module.exports = {
  validate,
  q,
  schemas,
  id,
  objectId,
  optionalObjectId,
  year,
  tonnes,
  money,
  price,
  role,
  isoDate,
  pagination,
};
