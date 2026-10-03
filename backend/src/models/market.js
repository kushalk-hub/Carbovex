'use strict';

/**
 * Market: orders, trades, payments, price history, and the audit log.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, positive, nowDate, appendOnly, check } = require('./helpers');

/**
 * A resting or filled order.
 *
 * There is no `userId`. The SQL schema did not have one either, and it is worth
 * being explicit about the consequence: an order records which *company* placed
 * it, not which of that company's employees. With one login per company — which
 * is what the demo seed creates — that is sufficient, and it also means a
 * company cannot be impersonated by another of its users. If the product ever
 * needs per-user attribution, add `userId` here and start writing it.
 *
 * `filledQty` is the field that makes matching safe: the matcher increments it
 * with a conditional update (`filledQty <= quantity - qty`), so two concurrent
 * matches against the same resting order cannot both succeed past its quantity.
 * That is the MongoDB equivalent of the `SELECT ... FOR UPDATE SKIP LOCKED`
 * loop in the SQL matcher.
 */
const MarketOrderSchema = new mongoose.Schema(
  {
    companyId: { ...ref('Company', { required: true }), required: true },
    side: { type: String, required: true, enum: ['BUY', 'SELL'] },
    quantity: { ...positive, required: true },
    filledQty: { ...nonNegative, default: 0 },
    pricePerCredit: { ...positive, required: true },
    status: {
      type: String,
      required: true,
      enum: ['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED'],
      default: 'OPEN',
    },
    createdAt: nowDate,
  },
  { ...base, collection: 'marketorders' },
);

// filled_qty >= 0 AND filled_qty <= quantity, from the SQL CHECK. The second
// half is the one that matters: it is the last line of defence against a
// matching bug over-filling an order.
//
// This must run BEFORE mongoose.model(): Mongoose snapshots the hook list when
// the model is compiled, so a pre('validate') hook added afterwards is silently
// ignored. That failure is invisible — no warning, the document just validates
// clean — which is why the rule is wired in here rather than in the service.
check(
  MarketOrderSchema,
  'filledQty',
  (doc) =>
    doc.filledQty <= doc.quantity ||
    `filledQty (${doc.filledQty}) cannot exceed quantity (${doc.quantity})`,
);

const MarketOrder = mongoose.model('MarketOrder', MarketOrderSchema);

// The order book: open orders, best price first, time priority within a level.
// This is the index the matching loop walks.
MarketOrderSchema.index({ side: 1, pricePerCredit: 1, createdAt: 1 });
MarketOrderSchema.index({ companyId: 1, createdAt: -1 });
MarketOrderSchema.index({ status: 1 });

/**
 * An executed trade.
 *
 * Immutable once written, and it carries no vintage or batch information: FIFO
 * allocation across a company's batches is recorded in the ledger rows that
 * reference this trade via `refTradeId`. Keeping it that way means a single
 * trade document cannot disagree with the ledger about which credits moved.
 */
const TradeSchema = appendOnly(
  new mongoose.Schema(
    {
      buyOrderId: { ...ref('MarketOrder', { required: true }), required: true },
      sellOrderId: { ...ref('MarketOrder', { required: true }), required: true },
      quantity: { ...positive, required: true },
      price: { ...positive, required: true },
      tradeTs: nowDate,
    },
    { ...base, collection: 'trades' },
  ),
  'trades',
);
// A self-trade would let one company both buy and sell its own credits for
// cash, moving money without moving net exposure. The matcher never creates
// one, but the constraint makes that a database fact rather than a convention.
check(
  TradeSchema,
  'sellOrderId',
  (doc) => String(doc.buyOrderId) !== String(doc.sellOrderId) || 'buyOrderId and sellOrderId must be different orders',
);
const Trade = mongoose.model('Trade', TradeSchema);
Trade.schema.index({ tradeTs: -1 });
Trade.schema.index({ buyOrderId: 1 });
Trade.schema.index({ sellOrderId: 1 });

/** One cash movement per trade, which is what makes cash balance checkable. */
const Payment = mongoose.model(
  'Payment',
  new mongoose.Schema(
    {
      tradeId: { ...ref('Trade', { required: true }), required: true },
      payerCompanyId: { ...ref('Company', { required: true }), required: true },
      payeeCompanyId: { ...ref('Company', { required: true }), required: true },
      amount: { ...positive, required: true },
      method: { type: String, required: true, enum: ['WALLET'], default: 'WALLET' },
      status: { type: String, required: true, enum: ['PAID', 'FAILED'], default: 'PAID' },
      paidAt: nowDate,
    },
    { ...base, collection: 'payments' },
  ),
);
Payment.schema.index({ tradeId: 1 }, { unique: true });

/**
 * Daily OHLCV, one document per day.
 *
 * `open`/`high`/`low`/`close` are null on a day with no trades, and refreshPriceHistory
 * guarantees a row exists for such a day rather than leaving a hole in the series —
 * a price chart with gaps renders candlesticks at the wrong width.
 *
 * The null is not a placeholder for zero. Trade.price is constrained to be strictly
 * positive (the SQL had CHECK (price_per_credit > 0)), so a recorded price of 0 is
 * not representable and null unambiguously means "no trades that day". That is the
 * reason the rule is safe here, and it is worth stating because the usual
 * justification for null-versus-zero does not apply to a price field.
 */
const PriceHistory = mongoose.model(
  'PriceHistory',
  new mongoose.Schema(
    {
      date: { type: Date, required: true, unique: true },
      open: { type: Number, default: null },
      high: { type: Number, default: null },
      low: { type: Number, default: null },
      close: { type: Number, default: null },
      volume: { ...nonNegative, default: 0 },
    },
    { ...base, collection: 'pricehistory' },
  ),
);
PriceHistory.schema.index({ date: -1 });

/**
 * The audit trail.
 *
 * In PostgreSQL this was populated by a generic AFTER trigger on eleven tables,
 * so it was impossible to forget. Here it is written explicitly by the services
 * that mutate, which means the "impossible to forget" property is gone — that
 * is a real loss and the reason services/audit.js is called from inside each
 * service rather than being left to the route handlers.
 *
 * `rowPk` is stored as a string because an ObjectId rendered as JSON in a log
 * viewer is unpleasant, and these rows outlive any particular driver version.
 */
const AuditLogSchema = appendOnly(
  new mongoose.Schema(
    {
      tableName: { type: String, required: true },
      operation: { type: String, required: true, enum: ['INSERT', 'UPDATE', 'DELETE'] },
      rowPk: { type: String, default: null },
      oldData: { type: mongoose.Schema.Types.Mixed, default: null },
      newData: { type: mongoose.Schema.Types.Mixed, default: null },
      // The acting user, from db/connect.js asUser().
      changedBy: { ...ref('User'), default: null },
      changedAt: nowDate,
    },
    { ...base, collection: 'auditlog' },
  ),
  'auditlog',
);
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
AuditLog.schema.index({ tableName: 1, changedAt: -1 });
AuditLog.schema.index({ changedBy: 1, changedAt: -1 });
AuditLog.schema.index({ changedAt: -1 });

module.exports = { MarketOrder, Trade, Payment, PriceHistory, AuditLog };
