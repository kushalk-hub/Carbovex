'use strict';

/**
 * Daily price history — fn_refresh_price_history and
 * fn_backfill_price_history.
 *
 * The behaviour that matters: a row exists for every day in range, even days
 * with no trades, and open/high/low/close are NULL rather than 0 on those days.
 *
 * That is a deliberate distinction, not tidiness. The price chart reads these
 * rows directly, and 0 is a real price. A day with no trades has no price at all,
 * and storing 0 there would draw a candle down to zero and make the chart lie
 * about the market being flat at the floor. The SQL inserted an explicit
 * volume-0 row for exactly this reason and refreshPriceHistory keeps doing it.
 */

const { errors } = require('../middleware/errors');
const { Trade, PriceHistory } = require('../models');

/** Midnight UTC on a given day. Compliance and price days are UTC days. */
function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Recompute one day's OHLCV.
 *
 * The SQL computed open and close with ARRAY_AGG over trade_ts in both
 * directions. Here the trades are sorted once ascending and the first and last
 * element of the resulting array are taken, which is the same thing and avoids
 * two scans of the day's trades.
 */
async function refreshPriceHistory(day, { session = null } = {}) {
  const from = startOfUtcDay(day);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

  const trades = await Trade.find({ tradeTs: { $gte: from, $lt: to } })
    .sort({ tradeTs: 1 })
    .session(session)
    .lean();

  // The date is the collection's identity: truncate to midnight so a caller
  // passing '2026-03-01' or '2026-03-01T14:22:00Z' updates one row, not two.
  const date = from;

  if (trades.length === 0) {
    // No trades: guarantee the row exists with null prices and zero volume.
    // $setOnInsert so an existing row is left alone — this path means "there
    // were no trades", and clobbering real prices because a late-arriving
    // trade had not landed yet would be wrong.
    return PriceHistory.findOneAndUpdate(
      { date },
      { $setOnInsert: { date, open: null, high: null, low: null, close: null, volume: 0 } },
      { upsert: true, new: true, session },
    ).exec();
  }

  const prices = trades.map((t) => t.price);
  const row = {
    date,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    volume: trades.reduce((sum, t) => sum + t.quantity, 0),
  };

  return PriceHistory.findOneAndUpdate(
    { date },
    { $set: row },
    // upsert is required, not an optimisation. Without it findOneAndUpdate
    // matches nothing for a day that has no row yet, returns null, and the day's
    // OHLCV is silently discarded — the price chart then has a hole for a day
    // that had trades. The SQL equivalent was ON CONFLICT (price_date) DO UPDATE.
    { session, upsert: true, new: true },
  ).exec();
}

/**
 * Backfill a date range, for seeding so the chart has history immediately.
 *
 * Returns the number of days written. Each day is its own upsert, so one bad day
 * does not discard the rest — which is a deliberate change from the SQL, where
 * the whole function ran in a single statement.
 */
async function backfillPriceHistory(from, to, { session = null } = {}) {
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  if (end < start) throw errors.badRequest('to must not be before from');

  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    await refreshPriceHistory(cursor, { session });
    days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The most recent N days of price history, for GET /market/prices. */
async function priceHistory({ from = null, to = null, limit = 365, session = null } = {}) {
  const query = {};
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = startOfUtcDay(from);
    if (to) query.date.$lt = startOfUtcDay(to);
  }

  return PriceHistory.find(query)
    .sort({ date: -1 })
    .limit(Math.min(Number(limit) || 365, 5000))
    .session(session)
    .lean();
}

/** The latest traded price, used to seed a new order's default. */
async function latestPrice({ session = null } = {}) {
  const row = await PriceHistory.findOne({ close: { $ne: null } })
    .sort({ date: -1 })
    .session(session)
    .lean();
  return row ? row.close : null;
}

module.exports = {
  startOfUtcDay,
  refreshPriceHistory,
  backfillPriceHistory,
  priceHistory,
  latestPrice,
};
