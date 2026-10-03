'use strict';

/**
 * GET    /api/market/depth     aggregated order book
 * GET    /api/market/trades    latest trades
 * GET    /api/market/prices    daily OHLC, gap-free
 * POST   /api/orders           place (auto-matches)
 * GET    /api/orders/mine      own orders
 * DELETE /api/orders/:id       cancel
 *
 * Matching lives entirely in the service layer (trading.js), which owns the
 * transaction and the conditional claim that stops an order being over-filled.
 * The API never settles a trade itself, because a trade settled in two places is
 * a trade that can disagree with itself.
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas, q } = require('../../middleware/validate');
const { requireAuth, requireCompany, asUserForRequest } = require('../../middleware/auth');
const { Trade, MarketOrder, CreditAccount, Company, PriceHistory } = require('../../models');
const { trading, pricing, aggregations } = require('../../services');
const realtime = require('../../realtime');
const { one, intParam } = require('../shape');

const router = express.Router();

// ---------------------------------------------------------------------------
// Read-only market data
// ---------------------------------------------------------------------------

/**
 * The order book, aggregated per price level with a running cumulative total.
 *
 * The SQL used a CTE plus `SUM(...) OVER (ORDER BY price)`. MongoDB 5.0+ has
 * $setWindowFields for that, but it is a heavier stage than this needs and it
 * would tie the endpoint to a minimum server version. The levels are at most
 * `levels` documents (capped at 50 by the query schema), so the running total is
 * accumulated in a plain loop instead: same result, no version requirement, and
 * the arithmetic is legible rather than a $reduce over a field that does not yet
 * exist at that point in the pipeline.
 */
async function withCumulative(side, levels) {
  const sortSpec = side === 'BUY' ? -1 : 1;

  const levels_ = await MarketOrder.aggregate([
    { $match: { side, status: { $in: ['OPEN', 'PARTIAL'] } } },
    { $addFields: { remaining: { $subtract: ['$quantity', '$filledQty'] } } },
    { $match: { remaining: { $gt: 0 } } },
    { $group: { _id: '$pricePerCredit', qty: { $sum: '$remaining' } } },
    { $sort: { _id: sortSpec } },
    { $limit: levels },
  ]).exec();

  let running = 0;
  return levels_.map((row) => {
    running += row.qty;
    return { price: row._id, qty: row.qty, cumulative: running };
  });
}

/**
 * GET /api/market/depth?levels=20
 *
 * The order book is public by design, so this is the one market endpoint that
 * does not require a company account.
 */
router.get(
  '/market/depth',
  requireAuth,
  validate(schemas.depthQuery, 'query'),
  async (req, res, next) => {
    try {
      const { levels } = q(req);

      const [bids, asks] = await Promise.all([withCumulative('BUY', levels), withCumulative('SELL', levels)]);

      const bestBid = bids[0]?.price ?? null;
      const bestAsk = asks[0]?.price ?? null;

      res.json({
        bids,
        asks,
        bestBid,
        bestAsk,
        // Null, not Infinity, when one side is empty — JSON has no Infinity.
        spread: bestBid != null && bestAsk != null ? Number((bestAsk - bestBid).toFixed(2)) : null,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/market/trades — most recent fills, newest first. */
router.get(
  '/market/trades',
  requireAuth,
  validate(schemas.tradesQuery, 'query'),
  async (req, res, next) => {
    try {
      const { limit, offset } = q(req);

      // The trade document deliberately carries no batch columns; the FIFO
      // vintage allocation lives in the ledger rows that reference the trade. The
      // two correlated subqueries below read the earliest vintage each side
      // received or gave up, which is what the UI labels a fill with.
      const trades = await Trade.aggregate([
        { $sort: { tradeTs: -1, _id: -1 } },
        { $skip: offset },
        { $limit: limit },
        {
          $lookup: {
            from: 'marketorders',
            localField: 'buyOrderId',
            foreignField: '_id',
            as: 'buy',
          },
        },
        { $lookup: { from: 'marketorders', localField: 'sellOrderId', foreignField: '_id', as: 'sell' } },
        { $unwind: { path: '$buy', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$sell', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'companies',
            localField: 'buy.companyId',
            foreignField: '_id',
            as: 'buyer',
          },
        },
        {
          $lookup: {
            from: 'companies',
            localField: 'sell.companyId',
            foreignField: '_id',
            as: 'seller',
          },
        },
        { $unwind: { path: '$buyer', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$seller', preserveNullAndEmptyArrays: true } },
        earliestVintage('tradeId', 'TRADE_IN', 'buyerVintage'),
        earliestVintage('tradeId', 'TRADE_OUT', 'sellerVintage'),
        {
          $project: {
            _id: 0,
            id: '$_id',
            price: 1,
            quantity: 1,
            tradedAt: '$tradeTs',
            buyerId: '$buy.companyId',
            buyer: '$buyer.name',
            sellerId: '$sell.companyId',
            seller: '$seller.name',
            buyerVintage: 1,
            sellerVintage: 1,
          },
        },
      ]).exec();

      res.json({
        trades: trades.map((t) => ({
          ...t,
          id: String(t.id),
          buyerId: t.buyerId ? String(t.buyerId) : null,
          sellerId: t.sellerId ? String(t.sellerId) : null,
        })),
        limit,
        offset,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * The earliest vintage a trade moved, for one side and one txn type.
 *
 * A $lookup cannot aggregate, so the ledger rows are pulled in and the minimum
 * taken per document. Only the rows for this trade are fetched, which the
 * (refTradeId, txnType) index makes cheap.
 */
function earliestVintage(tradeField, txnType, as) {
  return {
    $lookup: {
      from: 'creditledger',
      let: { tradeId: `$${tradeField}` },
      pipeline: [
        { $match: { $expr: { $eq: ['$refTradeId', '$$tradeId'] } } },
        { $match: { txnType } },
        {
          $lookup: {
            from: 'creditbatches',
            localField: 'batchId',
            foreignField: '_id',
            as: 'batch',
          },
        },
        { $unwind: '$batch' },
        { $group: { _id: null, vintage: { $min: '$batch.vintageYear' } } },
      ],
      as: '_vintage_' + as,
    },
  };
}

/**
 * GET /api/market/prices?from=&to=   or   ?days=30
 *
 * The gap-filling is the point of this endpoint. The SQL used generate_series
 * over missing days; here the range is materialised in JS and the stored rows
 * are looked up in one query. A price chart with gaps renders candlesticks at
 * the wrong width, and "no trades" has to be a real point carrying null prices
 * and zero volume rather than a hole in the series.
 */
router.get(
  '/market/prices',
  requireAuth,
  validate(schemas.pricesQuery, 'query'),
  async (req, res, next) => {
    try {
      const { from, to, days } = q(req);
      const end = to ?? new Date().toISOString().slice(0, 10);
      const start = from ?? new Date(Date.parse(end) - (days ?? 30) * 86_400_000).toISOString().slice(0, 10);

      if (start > end) return next(errors.badRequest('from must be on or before to'));

      const startDate = pricing.startOfUtcDay(start);
      const endExclusive = new Date(pricing.startOfUtcDay(end).getTime() + 86_400_000);

      const rows = await PriceHistory.find({ date: { $gte: startDate, $lt: endExclusive } })
        .sort({ date: 1 })
        .lean();

      const byDay = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));

      // Every day in the range, whether or not it has a stored row.
      const candles = [];
      const cursor = new Date(startDate);
      while (cursor < endExclusive) {
        const key = cursor.toISOString().slice(0, 10);
        const row = byDay.get(key);
        candles.push({
          date: key,
          // Null for a day with no trades, not 0 — 0 is a real price and would
          // draw a candle to the floor.
          open: row?.open ?? null,
          high: row?.high ?? null,
          low: row?.low ?? null,
          close: row?.close ?? null,
          volume: row?.volume ?? 0,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      res.json({ from: start, to: end, candles });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Order entry
// ---------------------------------------------------------------------------

/**
 * POST /api/orders
 *
 * The service writes the order and runs the matcher. The order's own transaction
 * commits before matching starts, so a counterparty who cannot trade does not
 * roll back the order itself — and the matching transaction is separate, so an
 * order that matched but whose fills partly failed still records what happened.
 */
router.post(
  '/orders',
  requireAuth,
  requireCompany(),
  validate(schemas.placeOrder),
  async (req, res, next) => {
    try {
      const { side, price, quantity } = req.body;

      const result = await asUserForRequest(req, () =>
        trading.placeOrder({
          companyId: req.companyId,
          side,
          quantity,
          pricePerCredit: price,
        }),
      );

      // Re-read the order: matching may have filled part or all of it, and
      // reporting the pre-match state would tell the client its order is unfilled
      // when it is not.
      const final = await MarketOrder.findById(result.order._id).lean();
      const balance = await CreditAccount.findOne({ companyId: req.companyId })
        .select('creditBalance cashBalance')
        .lean();

      const snapshot = await buildDepth();
      if (snapshot) realtime.emitOrderBook(snapshot);
      realtime.emitWallet(req.companyId, balance);
      realtime.emitToAll('trade:new', {
        orderId: String(result.order._id),
        trades: result.executed,
      });

      res.status(201).json({
        order: {
          orderId: String(final._id),
          side: final.side,
          quantity: final.quantity,
          filledQty: final.filledQty,
          price: final.pricePerCredit,
          status: final.status,
          createdAt: final.createdAt,
        },
        tradesExecuted: result.executed,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/orders/mine */
router.get(
  '/orders/mine',
  requireAuth,
  requireCompany(),
  validate(schemas.orderQuery, 'query'),
  async (req, res, next) => {
    try {
      const { limit, offset, status, side } = q(req);

      // Built as an explicit filter rather than the SQL's
      // `($2 IS NULL OR status = $2)`, which sent the parameter twice and relied
      // on Postgres's type inference to make the OR work. With an ObjectId there
      // is no such ambiguity.
      const filter = { companyId: req.companyId };
      if (status) filter.status = status;
      if (side) filter.side = side;

      const orders = await MarketOrder.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .lean();

      res.json({
        orders: orders.map((o) => ({
          id: String(o._id),
          side: o.side,
          price: o.pricePerCredit,
          quantity: o.quantity,
          filledQty: o.filledQty,
          remaining: o.quantity - o.filledQty,
          status: o.status,
          createdAt: o.createdAt,
        })),
        limit,
        offset,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * DELETE /api/orders/:id
 *
 * Only an open order can be cancelled, and only by the company that placed it.
 *
 * The service's update is conditional on both the ownership and the status in one
 * filter, so a fill that lands between the read and the write cannot leave a
 * filled order marked cancelled — the update simply matches nothing and the real
 * state is reported.
 */
router.delete(
  '/orders/:id',
  requireAuth,
  requireCompany(),
  async (req, res, next) => {
    try {
      const orderId = req.params.id;
      if (!/^[0-9a-fA-F]{24}$/.test(orderId)) {
        return next(errors.badRequest('id must be a 24-character hex ObjectId'));
      }

      const cancelled = await asUserForRequest(req, () =>
        trading.cancelOrder({ orderId, companyId: req.companyId }),
      );

      const snapshot = await buildDepth();
      if (snapshot) realtime.emitOrderBook(snapshot);

      res.json({ order: { orderId: String(cancelled._id), status: cancelled.status } });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * Rebuild the book for a broadcast, without an HTTP round trip.
 *
 * Returns null on failure rather than throwing: a failed broadcast must not fail
 * the request that caused it.
 */
async function buildDepth() {
  try {
    const [bids, asks] = await Promise.all([withCumulative('BUY', 20), withCumulative('SELL', 20)]);
    return { bids, asks };
  } catch {
    return null;
  }
}

module.exports = router;
module.exports.buildDepth = buildDepth;
module.exports.withCumulative = withCumulative;
