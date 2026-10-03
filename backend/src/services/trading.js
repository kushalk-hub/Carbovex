'use strict';

/**
 * The matching engine and trade execution — fn_execute_trade and
 * fn_match_orders in the SQL.
 *
 * Trade execution is the one place in this system where a bug is worth real
 * money, so the concurrency story is worth spelling out.
 *
 * In PostgreSQL, fn_execute_trade did `SELECT ... FOR UPDATE` on the two orders
 * in ascending id order, and the matcher used `FOR UPDATE SKIP LOCKED`. Row locks
 * gave exactly the guarantee needed: two trades touching the same order could not
 * both proceed.
 *
 * MongoDB has no row locks, so the same guarantee comes from conditional atomic
 * updates. `filledQty` is only advanced when `filledQty <= quantity - qty`, and
 * that single findOneAndUpdate either matches and claims the fill or does not.
 * If it does not, someone else got there first and this trade is abandoned. That
 * is the equivalent of the lock, and it is why the conditional filter is not
 * optional: an unconditional $inc would let two concurrent matches over-fill an
 * order and hand out credits that were never issued.
 *
 * The remaining transaction covers the rest — ledger rows, wallets, payment,
 * trade document — so a failure part-way leaves nothing behind. Combined: the
 * conditional update stops over-fill, the transaction stops partial state.
 */

const { errors } = require('../middleware/errors');
const { transaction } = require('../models/helpers');
const { MarketOrder, Trade, Payment, CreditAccount, CreditBatch } = require('../models');
const audit = require('./audit');
const aggregations = require('./aggregations');
const credits = require('./credits');

const { oid } = aggregations;

/** Round to 2dp, matching ROUND(..., 2) in SQL. Money is not a float. */
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * fn_execute_trade — move credits and cash for one matched pair.
 *
 * Either the whole trade exists or none of it does. The SQL locked the two orders
 * in ascending id order to avoid deadlocks; MongoDB's optimistic conditional
 * update has no lock ordering to get wrong, but writes are still issued in a
 * consistent order (orders, then ledger, then wallets, then payment) so a
 * deadlock is not introduced by habit.
 */
async function executeTrade({ buyOrderId, sellOrderId, quantity, session = null } = {}) {
  const run = async (s) => {
    const buyId = oid(buyOrderId, 'buyOrderId');
    const sellId = oid(sellOrderId, 'sellOrderId');
    const qty = Number(quantity);

    if (!Number.isFinite(qty) || qty <= 0) {
      throw errors.badRequest('Trade quantity must be greater than zero');
    }

    // Re-read both orders inside the transaction. The read is for validation
    // only — the authoritative claim happens in claimFill() below.
    const [buy, sell] = await Promise.all([
      MarketOrder.findById(buyId, null, { session: s }).lean(),
      MarketOrder.findById(sellId, null, { session: s }).lean(),
    ]);

    if (!buy || !sell) throw errors.notFound('One of the orders no longer exists');
    if (buy.side !== 'BUY') throw errors.unprocessable('Buy order is not a BUY order', 'CX003');
    if (sell.side !== 'SELL') throw errors.unprocessable('Sell order is not a SELL order', 'CX003');
    if (!['OPEN', 'PARTIAL'].includes(buy.status) || !['OPEN', 'PARTIAL'].includes(sell.status)) {
      throw errors.conflict('One of the orders is no longer open', 'CX003');
    }
    if (String(buy.companyId) === String(sell.companyId)) {
      throw errors.unprocessable('A company cannot trade with itself', 'CX003');
    }
    if (buy.pricePerCredit < sell.pricePerCredit) {
      throw errors.unprocessable('Buy price is below sell price', 'CX003');
    }
    if (qty > buy.quantity - buy.filledQty || qty > sell.quantity - sell.filledQty) {
      throw errors.conflict('Trade quantity exceeds the unfilled remainder', 'CX003');
    }

    // Price-time priority: the order that rested first sets the price.
    const price =
      buy.createdAt < sell.createdAt ? buy.pricePerCredit : sell.pricePerCredit;
    const cost = money(qty * price);

    // The claim. Both updates must succeed or neither is committed; because the
    // whole thing is one transaction, a partial claim rolls back.
    const buyClaimed = await claimFill(buyId, qty, s);
    const sellClaimed = await claimFill(sellId, qty, s);
    if (!buyClaimed || !sellClaimed) {
      throw errors.conflict('Another trade claimed this fill first', 'CX003');
    }

    // Buyer must have the cash before anything is written.
    const buyerAccount = await CreditAccount.findOne({ companyId: buy.companyId }).session(s).lean();
    if (!buyerAccount) {
      throw errors.internal(`Buyer ${buy.companyId} has no credit account`);
    }
    if (buyerAccount.cashBalance < cost) {
      // The SQL raised CX002 'Buyer has insufficient cash (% < %)'.
      throw errors.conflict(
        `Buyer has insufficient cash (${buyerAccount.cashBalance} < ${cost})`,
        'CX002',
      );
    }

    const trade = await audit.applyInsert(
      Trade,
      'trades',
      {
        buyOrderId: buyId,
        sellOrderId: sellId,
        quantity: qty,
        price,
        tradeTs: new Date(),
      },
      { session: s },
    );

    // FIFO across the seller's batches: older vintages expire sooner, so they
    // are the ones that should move first.
    const holdings = await aggregations.creditHoldings(sell.companyId, { session: s });
    let left = qty;

    for (const holding of holdings) {
      if (left <= 0) break;
      const take = Math.min(holding.qty, left);

      await credits.writeLedger({
        companyId: sell.companyId,
        batchId: holding.batchId,
        txnType: 'TRADE_OUT',
        quantity: -take,
        refTradeId: trade._id,
        session: s,
      });
      await credits.writeLedger({
        companyId: buy.companyId,
        batchId: holding.batchId,
        txnType: 'TRADE_IN',
        quantity: take,
        refTradeId: trade._id,
        session: s,
      });
      left -= take;
    }

    if (left > 0) {
      // CX001 in the SQL. Reached when the seller's holdings shrank between the
      // read above and here; the transaction rolls back, so nothing is stranded.
      throw errors.conflict('Seller lacks tradable credits', 'CX001');
    }

    await credits.adjustCash({ companyId: buy.companyId, delta: -cost, session: s });
    await credits.adjustCash({ companyId: sell.companyId, delta: cost, session: s });

    await audit.applyInsert(
      Payment,
      'payments',
      {
        tradeId: trade._id,
        payerCompanyId: buy.companyId,
        payeeCompanyId: sell.companyId,
        amount: cost,
        method: 'WALLET',
        status: 'PAID',
        paidAt: new Date(),
      },
      { session: s },
    );

    return {
      tradeId: trade._id,
      quantity: qty,
      price,
      cost,
      buyerCompanyId: buy.companyId,
      sellerCompanyId: sell.companyId,
      tradeTs: trade.tradeTs,
    };
  };

  return session ? run(session) : transaction(run);
}

/**
 * Atomically advance an order's filledQty, but only if it fits.
 *
 * The `filledQty: { $lte: quantity - qty }` filter is the whole concurrency
 * control. If another transaction already consumed the remainder, the filter
 * fails, the update returns null, and the caller abandons the trade. No lock, no
 * retry loop, no possibility of over-filling.
 */
async function claimFill(orderId, qty, session) {
  // Two things force this to be a raw-collection *pipeline* update rather than a
  // model findOneAndUpdate.
  //
  // 1. Mongoose casts update values against the schema, and status here is an
  //    aggregation expression, so the model call fails with:
  //      Cast to string failed for value "{ '$cond': [...] }" at path "status"
  //
  // 2. More seriously, a classic `{ $set: { field: { $cond: ... } } }` does not
  //    evaluate the expression at all — it *stores the object verbatim*. The
  //    document was left with `status: { $cond: [...] }`, which then failed every
  //    `status: { $in: ['OPEN','PARTIAL'] }` match in the matcher and the order
  //    book, so a single fill silently removed the order from the market. That is
  //    the failure mode aggregation expressions in classic updates actually have,
  //    and it is much worse than an error.
  //
  // A pipeline update (MongoDB 4.2+) is evaluated properly, and putting both
  // fields in one $set stage means they are computed from the same pre-update
  // document — so status reflects the fill that is being applied, not one that has
  // already happened.
  //
  // The split into two updates is not an option: it would break the atomicity
  // that makes this safe, leaving filledQty advanced with status stale if the
  // process died between them.
  //
  // Update validators do not run on a pipeline update, which is correct rather
  // than a gap: MarketOrder's filledQty <= quantity rule is precisely the
  // invariant the filter's $expr enforces.
  const result = await MarketOrder.collection.findOneAndUpdate(
    {
      _id: orderId,
      status: { $in: ['OPEN', 'PARTIAL'] },
      // The claim: the unfilled remainder must be at least qty. $expr compares
      // two fields of the same document, which a plain filter cannot.
      $expr: { $gte: [{ $subtract: ['$quantity', '$filledQty'] }, qty] },
    },
    [
      {
        $set: {
          filledQty: { $add: ['$filledQty', qty] },
          status: {
            $cond: [
              { $gte: [{ $add: ['$filledQty', qty] }, '$quantity'] },
              'FILLED',
              'PARTIAL',
            ],
          },
        },
      },
    ],
    { session, returnDocument: 'after' },
  );

  return Boolean(result);
}

/**
 * fn_match_orders — sweep the book and execute whatever crosses.
 *
 * Returns the number of trades executed.
 *
 * Structure follows the SQL closely, including the two guards that matter:
 *
 *   - a 500-iteration cap per incoming order, so a pathological book cannot spin
 *   - each attempt is independent: a counterparty who cannot trade (no credits,
 *     no cash) is skipped, not fatal. The SQL caught CX001/CX002/CX003 per
 *     attempt; here the transaction rejects, and the next attempt proceeds.
 *
 * A note on transaction scope: each attempt gets its own transaction rather than
 * sharing one. The SQL used an EXCEPTION block with a subtransaction, which is
 * the same idea — an individual trade commits or rolls back without discarding
 * the matches before or after it.
 */
async function matchOrders({ session = null, guard = 500 } = {}) {
  const buys = await MarketOrder.find({
    side: 'BUY',
    status: { $in: ['OPEN', 'PARTIAL'] },
  })
    .sort({ pricePerCredit: -1, createdAt: 1, _id: 1 })
    .session(session)
    .lean();

  let executed = 0;

  for (const buy of buys) {
    let guardCount = 0;
    let buyRemaining = buy.quantity - buy.filledQty;

    // Counterparties already found untradeable during this sweep. The SQL got
    // this for free from SKIP LOCKED plus its EXCEPTION handler: a locked row was
    // skipped, and a failed attempt did not re-select the same row because the
    // cursor had already moved past it. MongoDB has neither, so the exclusion
    // list is what stops the loop from re-picking one broken seller 500 times.
    const unusable = [];

    while (buyRemaining > 0 && guardCount < guard) {
      guardCount += 1;

      // SKIP LOCKED's role is served by the conditional claim in claimFill: if a
      // concurrent matcher got there first, the update matches nothing and the
      // trade is abandoned rather than blocking. The next iteration picks up the
      // following counterparty.
      const sellQuery = {
        side: 'SELL',
        status: { $in: ['OPEN', 'PARTIAL'] },
        pricePerCredit: { $lte: buy.pricePerCredit },
        companyId: { $ne: buy.companyId },
        // Only genuinely part-filled orders can be the counterparty.
        $expr: { $lt: ['$filledQty', '$quantity'] },
      };
      if (unusable.length) sellQuery._id = { $nin: unusable };

      const sell = await MarketOrder.findOne(sellQuery)
        .sort({ pricePerCredit: 1, createdAt: 1, _id: 1 })
        .session(session)
        .lean();

      if (!sell) break;

      const qty = Math.min(buyRemaining, sell.quantity - sell.filledQty);
      if (qty <= 0) {
        unusable.push(sell._id);
        continue;
      }

      try {
        const trade = await executeTrade({
          buyOrderId: buy._id,
          sellOrderId: sell._id,
          quantity: qty,
        });
        executed += 1;
        buyRemaining -= qty;
        // Realtime emission. The SQL used pg_notify inside the transaction, so a
        // rollback sent nothing; here the emit happens after executeTrade has
        // returned, which means after the transaction committed. Same guarantee
        // by construction. See realtime/changeStream.js for the change-stream
        // path that covers writes from other processes.
        emitTrade(trade);
      } catch (err) {
        if (isSkippable(err)) {
          // This counterparty cannot trade right now — no credits, no cash, or a
          // concurrent claim won the race. Skip it and try the next, which is
          // what the SQL's per-attempt EXCEPTION block did.
          unusable.push(sell._id);
          continue;
        }
        throw err;
      }
    }
  }

  return executed;
}

/**
 * Errors the matcher treats as "this counterparty, not this sweep, failed".
 *
 * The SQL caught SQLSTATE CX001/CX002/CX003 per attempt and ignored them. Only
 * those three are skippable: they all mean a specific counterparty cannot trade
 * right now, and the sweep should move to the next one. Everything else — a
 * 500, a CastError, a lost connection — must abort the whole sweep, or a real
 * fault gets swallowed and the matcher reports a success it did not achieve.
 */
function isSkippable(err) {
  if (!err || !err.code) return false;
  return SKIPPABLE_CODES.has(err.code);
}

const SKIPPABLE_CODES = new Set(['CX001', 'CX002', 'CX003']);

/**
 * Place an order and immediately try to match it.
 *
 * The order is written in its own transaction and matching runs after, so a
 * counterparty who cannot trade does not roll back the order itself.
 */
async function placeOrder({ companyId, side, quantity, pricePerCredit, session = null } = {}) {
  const qty = Number(quantity);
  const price = Number(pricePerCredit);

  if (!Number.isFinite(qty) || qty <= 0) throw errors.badRequest('quantity must be greater than zero');
  if (!Number.isFinite(price) || price <= 0) throw errors.badRequest('pricePerCredit must be greater than zero');
  if (!['BUY', 'SELL'].includes(side)) throw errors.badRequest('side must be BUY or SELL');

  const run = async (s) => {
    // A SELL order must be backed by credits. Checked here so the order does not
    // sit in the book unfillable, which would show a phantom seller in the book
    // and repeatedly fail the matcher.
    if (side === 'SELL') {
      const holdings = await aggregations.creditHoldings(companyId, { session: s });
      const available = holdings.reduce((sum, h) => sum + h.qty, 0);
      if (available < qty) {
        throw errors.conflict(
          `Cannot sell ${qty} credits: only ${available} are held in unexpired batches`,
          'CX001',
        );
      }
    }

    await credits.ensureAccount(companyId, s);

    return audit.applyInsert(
      MarketOrder,
      'marketorders',
      {
        companyId: oid(companyId, 'companyId'),
        side,
        quantity: qty,
        filledQty: 0,
        pricePerCredit: price,
        status: 'OPEN',
        createdAt: new Date(),
      },
      { session: s },
    );
  };

  const order = await (session ? run(session) : transaction(run));
  const executed = await matchOrders({ session });
  return { order, executed };
}

/** Cancel an order that is still open, and only if the caller owns it. */
async function cancelOrder({ orderId, companyId }) {
  const id = oid(orderId, 'orderId');
  const company = oid(companyId, 'companyId');

  const result = await audit.applyUpdate(
    MarketOrder,
    'marketorders',
    { _id: id, companyId: company, status: { $in: ['OPEN', 'PARTIAL'] } },
    { $set: { status: 'CANCELLED' } },
    {},
  );

  if (!result) {
    const existing = await MarketOrder.findById(id).lean();
    if (!existing) throw errors.notFound(`Order ${orderId} not found`);
    if (String(existing.companyId) !== String(company)) {
      throw errors.forbidden('That order belongs to another company');
    }
    throw errors.conflict(`Order is already ${existing.status} and cannot be cancelled`);
  }
  return result;
}

/** Realtime hook, injected by realtime/index.js to avoid a circular require. */
let emitTrade = () => {};
function setTradeEmitter(fn) {
  emitTrade = typeof fn === 'function' ? fn : () => {};
}

module.exports = {
  executeTrade,
  claimFill,
  matchOrders,
  placeOrder,
  cancelOrder,
  money,
  isSkippable,
  setTradeEmitter,
};
