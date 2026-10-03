'use strict';

/**
 * GET /api/audit-log
 *
 * The trail of who changed what, with the before/after of each change and the
 * acting user.
 *
 * This used to be a trigger: `trg_audit AFTER INSERT OR UPDATE OR DELETE` on
 * eleven tables, which meant the trail was populated by the database and could
 * not be forgotten. It is now written by services/audit.js, so the population is
 * the application's responsibility. See the note at the top of that file — it is
 * the most significant behavioural regression of the PostgreSQL to MongoDB move.
 *
 * Admin and auditor only: the trail necessarily contains other companies' data.
 */

const express = require('express');
const { validate, schemas, q } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { aggregations } = require('../../services');
const { camelise, diffKeys } = require('../shape');

const router = express.Router();

router.get(
  '/',
  requireAuth,
  requireRole('ADMIN', 'AUDITOR'),
  validate(schemas.auditQuery, 'query'),
  async (req, res, next) => {
    try {
      const { limit, offset, table } = q(req);

      const [rows, total] = await Promise.all([
        aggregations.auditTrail({ tableName: table, limit: limit + offset }),
        // Counted separately: the aggregation applies $limit, so a second call
        // for the count is cheaper than a facet over the whole collection.
        aggregations.countAuditRows({ tableName: table }),
      ]);

      const entries = rows.slice(offset, offset + limit).map((e) => ({
        id: e.rowPk,
        table: e.tableName,
        operation: e.operation,
        rowPk: e.rowPk,
        changedAt: e.changedAt,
        changedBy: e.changedBy,
        // The acting user is resolved by a $lookup in the aggregation, so a
        // renamed or deleted account still shows the name that was recorded.
        changedByName: e.changedByName,
        // A diff, not two blobs: "which field actually changed" is the only
        // question anyone opens an audit log to answer.
        diff: diffKeys(e.oldData, e.newData),
        old: camelise(e.oldData),
        new: camelise(e.newData),
      }));

      res.json({ total, entries, limit, offset });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
