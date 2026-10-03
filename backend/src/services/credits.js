'use strict';

/**
 * Credits: issuing batches, moving balances, and retiring.
 *
 * This file is where the append-only ledger and the wallet balances meet, and it
 * is the most safety-critical service in the codebase. The invariant it maintains:
 *
 *   creditaccounts.creditBalance == SUM(creditledger.quantity WHERE company = X)
 *
 * In PostgreSQL that was guaranteed by trg_ledger_balance, an AFTER INSERT
 * trigger on the ledger, so no code path could produce a disagreement. MongoDB
 * has no triggers, so every mutation here updates both inside one transaction.
 * If the transaction is unavailable, `withTransaction` in db/connect.js fails
 * loudly rather than letting the two drift — see the note there.
 *
 * That is the correct trade, but it is a trade: the invariant is now enforced by
 * this service and by the carbonx_app role's permissions, not by the database.
 * Anyone with a direct connection and update rights on creditaccounts can break
 * it. verifyBalance() exists so the test suite can prove it is currently intact.
 */

const { errors } = require('../middleware/errors');
const {
  CreditBatch,
  CreditLedger,
  CreditAccount,
  CreditRetirement,
  OffsetProject,
  CompliancePeriod,
} = require('../models');
const { transaction } = require('../models/helpers');
const audit = require('./audit');
const aggregations = require('./aggregations');

const { oid } = aggregations;

/**
 * Get or create a company's wallet.
 *
 * Created lazily rather than by a trigger on company INSERT, because a
 * $setOnInsert upsert is the MongoDB equivalent and keeps the wallet in the same
 * transaction as whatever needed it.
 *
 * The `const [account] =` shape is for `create()`, which resolves to an array.
 * findOneAndUpdate resolves to a single document, so it is not destructured —
 * doing so throws "is not iterable" on the first call, which is how this was
 * found.
 */
async function ensureAccount(companyId, session) {
  const account = await CreditAccount.findOneAndUpdate(
    { companyId },
    { $setOnInsert: { companyId, creditBalance: 0, cashBalance: 0, updatedAt: new Date() } },
    { upsert: true, new: true, session },
  ).exec();
  return account;
}

/**
 * fn_issue_batch — create a batch and credit its owner.
 *
 * The ledger row and the wallet increment are one transaction: a batch with no
 * matching ISSUE entry would make holdings understate reality, and a wallet
 * credit with no batch would make credits exist from nowhere.
 */
async function issueBatch({ projectId, vintageYear, quantity, expiryYear = null, session = null } = {}) {
  const run = async (s) => {
    const project = await OffsetProject.findById(oid(projectId, 'projectId'), null, { session: s }).lean();
    if (!project) throw errors.notFound(`Offset project ${projectId} not found`);

    const vintage = Number(vintageYear);
    const qty = Number(quantity);
    if (!Number.isFinite(vintage) || !Number.isInteger(vintage)) {
      throw errors.badRequest('vintageYear must be an integer');
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw errors.badRequest('quantity must be greater than zero');
    }

    // fn_issue_batch rejected a vintage before the current year.
    const currentYear = new Date().getUTCFullYear();
    if (vintage < currentYear) {
      throw errors.unprocessable(`Vintage year ${vintage} is in the past`, 'CX003');
    }

    const expiry = expiryYear == null ? vintage + 5 : Number(expiryYear);
    if (expiry < vintage) {
      throw errors.unprocessable(`expiryYear (${expiry}) must be >= vintageYear (${vintage})`, 'CX003');
    }

    // The owner's wallet must exist before the ledger row, because writeLedger
    // moves the wallet with the same conditional update that enforces a
    // non-negative balance. With no row to match, the update finds nothing and
    // the ledger entry is stranded.
    //
    // In PostgreSQL this was implicit: a trigger created the wallet on company
    // INSERT. That trigger is gone, so the service that first needs the wallet is
    // the one that creates it — and doing it here keeps it in the same
    // transaction as the issue it funds.
    await ensureAccount(project.ownerCompanyId, s);

    const batch = await audit.applyInsert(
      CreditBatch,
      'creditbatches',
      {
        projectId: project._id,
        vintageYear: vintage,
        quantity: qty,
        expiryYear: expiry,
        status: 'ACTIVE',
        issuedAt: new Date(),
      },
      { session: s },
    );

    // The ISSUE entry, and the owner's wallet, in the same transaction.
    await writeLedger({
      companyId: project.ownerCompanyId,
      batchId: batch._id,
      txnType: 'ISSUE',
      quantity: qty,
      session: s,
    });

    return batch;
  };

  return session ? run(session) : transaction(run);
}

/**
 * Write one ledger row and move the wallet to match.
 *
 * Every balance change in the system goes through here, which is what keeps the
 * invariant in the file header true. The wallet update is conditional on the
 * resulting balance staying non-negative, so an oversell loses the race cleanly
 * with a null match instead of writing a negative balance.
 */
async function writeLedger({ companyId, batchId, txnType, quantity, refTradeId = null, refRetirementId = null, session }) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0) {
    throw errors.badRequest('Ledger quantity must be a non-zero number');
  }

  const ledgerRow = await audit.applyInsert(
    CreditLedger,
    'creditledger',
    {
      companyId,
      batchId,
      txnType,
      quantity: qty,
      refTradeId,
      refRetirementId,
      createdAt: new Date(),
    },
    { session },
  );

  // $inc is atomic, so concurrent trades cannot lose an update.
  const updated = await CreditAccount.findOneAndUpdate(
    { companyId, creditBalance: { $gte: -qty } },
    { $inc: { creditBalance: qty }, $set: { updatedAt: new Date() } },
    { session },
  ).exec();

  if (!updated) {
    // Either the wallet does not exist yet, or this would take it negative.
    // Distinguish the two, because the fix differs.
    const existing = await CreditAccount.findOne({ companyId }).session(session).lean();
    if (!existing) {
      throw errors.internal(`No credit account for company ${companyId}; ledger row ${ledgerRow._id} written without one`);
    }
    throw errors.conflict(
      `Insufficient credits: balance ${existing.creditBalance} cannot absorb ${qty}`,
      'CX001',
    );
  }

  return ledgerRow;
}

/** Move cash. Same pattern as writeLedger, different column. */
async function adjustCash({ companyId, delta, session }) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) {
    throw errors.badRequest('Cash adjustment must be a non-zero number');
  }

  const updated = await CreditAccount.findOneAndUpdate(
    { companyId, cashBalance: { $gte: -amount } },
    { $inc: { cashBalance: amount }, $set: { updatedAt: new Date() } },
    { session },
  ).exec();

  if (!updated) {
    const existing = await CreditAccount.findOne({ companyId }).session(session).lean();
    if (!existing) throw errors.internal(`No credit account for company ${companyId}`);
    throw errors.conflict(
      `Insufficient cash: balance ${existing.cashBalance} cannot absorb ${amount}`,
      'CX002',
    );
  }
  return updated;
}

/**
 * fn_retire_credits — surrender credits against a compliance obligation.
 *
 * Returns how much was ACTUALLY retired, which may be less than requested: a
 * company short of credits retires what it has and owes the rest as a fine. The
 * caller (runPeriodCompliance) depends on that return value to decide whether
 * the shortfall becomes a penalty, so returning the requested amount here would
 * silently erase penalties.
 *
 * FIFO across vintages, oldest first, because older credits expire sooner.
 */
async function retireCredits({ companyId, quantity, periodId = null, session = null } = {}) {
  const run = async (s) => {
    const company = oid(companyId, 'companyId');
    const requested = Number(quantity);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw errors.badRequest('Retirement quantity must be greater than zero');
    }
    if (periodId) await CompliancePeriod.exists({ _id: oid(periodId, 'periodId') }).session(s);

    await ensureAccount(company, s);

    // Holdings are read *inside* the transaction and filtered to batches that are
    // active and unexpired, so credits cannot be retired twice if two requests
    // race: the second transaction sees the first one's RETIRE rows.
    const holdings = await aggregations.creditHoldings(company, { session: s });

    let left = requested;
    const retirements = [];
    for (const holding of holdings) {
      if (left <= 0) break;
      const take = Math.min(holding.qty, left);

      // Retirement first: the ledger row references it via refRetirementId.
      const retirement = await audit.applyInsert(
        CreditRetirement,
        'creditretirements',
        {
          companyId: company,
          periodId: periodId ? oid(periodId, 'periodId') : null,
          batchId: holding.batchId,
          quantity: take,
          retiredAt: new Date(),
        },
        { session: s },
      );

      await writeLedger({
        companyId: company,
        batchId: holding.batchId,
        txnType: 'RETIRE',
        quantity: -take,
        refRetirementId: retirement._id,
        session: s,
      });

      retirements.push(retirement);
      left -= take;
    }

    // The difference between asked for and achieved. The SQL returned
    // p_qty - v_left for exactly this reason.
    return {
      retired: requested - left,
      requested,
      shortfall: left,
      retirements,
    };
  };

  return session ? run(session) : transaction(run);
}

/**
 * fn_expire_credits — write off holdings in batches past their expiry year.
 *
 * Returns the number of (company, batch) pairs written off. Each EXPIRE row
 * negates the outstanding balance, so holdings go to zero without deleting
 * anything — the ledger is append-only and an expiry is a real event with a
 * date, not an erasure.
 */
async function expireCredits({ now = new Date(), session = null } = {}) {
  const run = async (s) => {
    const currentYear = now.getUTCFullYear();

    // Outstanding positive balances on expired batches: a $lookup to batches,
    // filtered to those past their expiry year, then grouped. Same shape as the
    // SQL's JOIN + GROUP BY + HAVING.
    const outstanding = await CreditLedger.aggregate(
      [
        {
          $lookup: {
            from: 'creditbatches',
            localField: 'batchId',
            foreignField: '_id',
            as: 'batch',
          },
        },
        { $unwind: '$batch' },
        { $match: { 'batch.status': 'ACTIVE', 'batch.expiryYear': { $ne: null, $lt: currentYear } } },
        {
          $group: {
            _id: { companyId: '$companyId', batchId: '$batchId' },
            qty: { $sum: '$quantity' },
          },
        },
        // HAVING SUM(l.quantity) > 0
        { $match: { qty: { $gt: 0 } } },
      ],
      { session: s },
    ).exec();

    for (const row of outstanding) {
      await writeLedger({
        companyId: row._id.companyId,
        batchId: row._id.batchId,
        txnType: 'EXPIRE',
        quantity: -row.qty,
        session: s,
      });
    }

    if (outstanding.length) {
      await CreditBatch.updateMany(
        { status: 'ACTIVE', expiryYear: { $ne: null, $lt: currentYear } },
        { $set: { status: 'EXPIRED' } },
        { session: s },
      );
    }

    return outstanding.length;
  };

  return session ? run(session) : transaction(run);
}

/**
 * Verify the wallet/ledger invariant.
 *
 * The replacement for the fact that a trigger made disagreement impossible. This
 * is how the test suite proves the hand-written maintenance is still correct, and
 * it is worth running against production data on a schedule: it is a single
 * aggregation and it is the only thing standing between a bug and silent
 * corruption of the balances.
 */
async function verifyBalance(companyId = null, { session = null } = {}) {
  const match = {};
  if (companyId) match._id = oid(companyId, 'companyId');

  const [stored, summed] = await Promise.all([
    CreditAccount.aggregate(
      [
        ...(companyId ? [{ $match: match }] : []),
        { $project: { _id: 0, companyId: 1, creditBalance: 1, cashBalance: 1 } },
      ],
      { session },
    ).exec(),
    CreditLedger.aggregate(
      [
        ...(companyId ? [{ $match: { companyId: oid(companyId, 'companyId') } }] : []),
        { $group: { _id: '$companyId', total: { $sum: '$quantity' } } },
      ],
      { session },
    ).exec(),
  ]);

  const ledgerByCompany = new Map(summed.map((r) => [String(r._id), r.total]));
  const mismatches = [];

  for (const account of stored) {
    const ledgerTotal = ledgerByCompany.get(String(account.companyId)) ?? 0;
    if (Math.abs(account.creditBalance - ledgerTotal) > 0.01) {
      mismatches.push({
        companyId: account.companyId,
        walletBalance: account.creditBalance,
        ledgerTotal,
        difference: account.creditBalance - ledgerTotal,
      });
    }
  }

  return { checked: stored.length, ok: mismatches.length === 0, mismatches };
}

/** Wallet summary for GET /wallet, joining the company and its holdings. */
async function walletSummary(companyId, { session = null } = {}) {
  const company = oid(companyId, 'companyId');
  const account = await ensureAccount(company, session);
  const holdings = await aggregations.creditHoldings(company, { session });

  return {
    companyId: company,
    creditBalance: account.creditBalance,
    cashBalance: account.cashBalance,
    totalCredits: holdings.reduce((sum, h) => sum + h.qty, 0),
    holdings,
    updatedAt: account.updatedAt,
  };
}

module.exports = {
  ensureAccount,
  issueBatch,
  writeLedger,
  adjustCash,
  retireCredits,
  expireCredits,
  verifyBalance,
  walletSummary,
};
