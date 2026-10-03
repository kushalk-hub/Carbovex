'use strict';

/**
 * GET /api/stats/overview
 *
 * The TopBar KPI strip. One round trip, all numeric. Deliberately aggregate-only:
 * the marketplace KPI row must not become a slow query over 745k readings.
 *
 * The SQL was one large statement with CTEs CROSS JOINed together. Here the
 * pieces are independent aggregations run concurrently, because MongoDB has no
 * CTE and forcing them into one pipeline would mean a single $facet over unrelated
 * collections — which is legal, but reads as one query while actually running
 * seven. Running them in parallel is both faster and clearer about what each
 * number costs.
 */

const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../../middleware/auth');
const {
  PeriodTotal,
  CreditLedger,
  CreditBatch,
  Trade,
  PriceHistory,
  Facility,
  Sensor,
  Alert,
} = require('../../models');

const router = express.Router();

/** A missing aggregate row is zero, not an error. */
const zero = (rows, field) => (rows.length ? Number(rows[0][field] ?? 0) : 0);

router.get(
  '/overview',
  requireAuth,
  async (req, res, next) => {
    try {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const currentYear = now.getUTCFullYear();

      const [
        totals,
        circulation,
        volume,
        lastPrice,
        facilities,
        sensorsOnline,
        unreadAlerts,
      ] = await Promise.all([
        // Total emitted, and how many companies have reported at all.
        PeriodTotal.aggregate([
          {
            $group: {
              _id: null,
              totalEmitted: { $sum: '$tonnes' },
              // COUNT(DISTINCT company_id) — $addToSet then $size, since $group
              // has no count-distinct accumulator.
              companies: { $addToSet: '$companyId' },
            },
          },
          { $project: { _id: 0, totalEmitted: 1, companiesActive: { $size: '$companies' } } },
        ]).exec(),

        // Credits still held and not expired, net of everything spent. The same
        // expiry rule as the holdings view: a null expiry never expires.
        CreditLedger.aggregate([
          {
            $lookup: {
              from: 'creditbatches',
              localField: 'batchId',
              foreignField: '_id',
              as: 'batch',
            },
          },
          { $unwind: '$batch' },
          { $match: { 'batch.status': 'ACTIVE' } },
          {
            $match: {
              $or: [{ 'batch.expiryYear': null }, { 'batch.expiryYear': { $gte: currentYear } }],
            },
          },
          { $group: { _id: null, creditsHeld: { $sum: '$quantity' } } },
        ]).exec(),

        // Rolling 24h volume and trade count.
        Trade.aggregate([
          { $match: { tradeTs: { $gte: dayAgo } } },
          { $group: { _id: null, volume: { $sum: '$quantity' }, trades: { $sum: 1 } } },
        ]).exec(),

        // The last day that actually traded. Days with no trades are stored with
        // null prices, so filtering on close != null is what makes this "the last
        // price" rather than "yesterday's null".
        PriceHistory.findOne({ close: { $ne: null } })
          .sort({ date: -1 })
          .select('close date')
          .lean(),

        Facility.estimatedDocumentCount().exec(),
        Sensor.countDocuments({ status: 'ONLINE' }),
        Alert.countDocuments({ isRead: false }),
      ]);

      res.json({
        totalEmitted: zero(totals, 'totalEmitted'),
        creditsHeld: zero(circulation, 'creditsHeld'),
        volume24h: zero(volume, 'volume'),
        trades24h: zero(volume, 'trades'),
        lastPrice: lastPrice?.close ?? null,
        lastPriceDate: lastPrice?.date ?? null,
        companiesActive: zero(totals, 'companiesActive'),
        facilities,
        sensorsOnline,
        unreadAlerts,
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
