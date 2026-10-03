'use strict';

/**
 * Credits: projects, batches, wallets, the ledger, retirements, penalties.
 *
 * The ledger is the spine of the system. Every change in who owns how many
 * credits is a row in creditLedger, and nothing else is allowed to move that
 * number. Read the CreditLedger comment before touching this file.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, positive, nowDate, appendOnly, check } = require('./helpers');

const OffsetProject = mongoose.model(
  'OffsetProject',
  new mongoose.Schema(
    {
      registryId: { ...ref('Registry'), default: null },
      projectTypeId: { ...ref('ProjectType'), default: null },
      ownerCompanyId: { ...ref('Company', { required: true }), required: true },
      cityId: { ...ref('City'), default: null },
      name: { type: String, required: true, trim: true },
      startDate: { type: Date, default: null },
      estAnnualCredits: { ...nonNegative, default: null },
      status: { type: String, required: true, enum: ['PENDING', 'ACTIVE', 'CLOSED'], default: 'ACTIVE' },
    },
    { ...base, collection: 'offsetprojects' },
  ),
);
OffsetProject.schema.index({ ownerCompanyId: 1 });

/**
 * A batch of issued credits.
 *
 * `quantity` is the total ever issued for this batch and never changes.
 * A company's share is derived from the ledger, not stored here.
 */
const CreditBatch = mongoose.model(
  'CreditBatch',
  check(
    new mongoose.Schema(
      {
        projectId: { ...ref('OffsetProject', { required: true }), required: true },
        vintageYear: { type: Number, required: true },
        quantity: { ...positive, required: true },
        serialStart: { type: Number, default: null },
        serialEnd: { type: Number, default: null },
        expiryYear: { type: Number, default: null },
        issuedAt: nowDate,
        status: { type: String, required: true, enum: ['ACTIVE', 'EXPIRED', 'SUSPENDED'], default: 'ACTIVE' },
      },
      { ...base, collection: 'creditbatches' },
    ),
    'expiryYear', // expiry_year >= vintage_year, from the SQL CHECK.
    (doc) =>
      doc.expiryYear == null ||
      doc.expiryYear >= doc.vintageYear ||
      `expiryYear (${doc.expiryYear}) must be >= vintageYear (${doc.vintageYear})`,
  ),
);
// The "what can I sell right now" query: active, unexpired, by vintage.
CreditBatch.schema.index({ status: 1, expiryYear: 1, vintageYear: 1 });
CreditBatch.schema.index({ projectId: 1 });

/**
 * Wallet balances.
 *
 * In PostgreSQL these were maintained by an AFTER-INSERT trigger on
 * credit_ledger, so the balance could not drift no matter what wrote the
 * ledger. MongoDB has no triggers, so services/credits.js updates the account
 * inside the same transaction as the ledger entry.
 *
 * The cost of that trade is worth stating plainly: the database will now accept
 * a ledger row that nobody has balanced, if something other than this API writes
 * one. The `min: 0` validator catches the case where the balance goes negative,
 * but not the case where it is merely wrong.
 */
const CreditAccount = mongoose.model(
  'CreditAccount',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      creditBalance: { ...nonNegative, default: 0 },
      cashBalance: { ...nonNegative, default: 0 },
      updatedAt: nowDate,
    },
    { ...base, collection: 'creditaccounts' },
  ),
);
CreditAccount.schema.index({ companyId: 1 }, { unique: true });

/**
 * The credit ledger. Append-only, and the only authority on balances.
 *
 * Entry types: ISSUE (batch issued to a company, positive),
 * TRADE_IN / TRADE_OUT (a trade, ±), RETIRE (negative),
 * EXPIRE (negative, offsetting the original issue), ADJUST (correction).
 *
 * `quantity` is signed. The SQL had `CHECK (quantity <> 0)`, mirrored here by
 * `validate` below, because a zero-value entry is always a bug — it makes the
 * running total work but records no movement.
 *
 * Append-only was enforced by a BEFORE UPDATE/DELETE trigger in SQL. Here it is
 * a model-level guard (see helpers.appendOnly) *and*, where the app connects as
 * the carbonx_app role, a database-level permission: that role has insert but
 * not update or remove on this collection. The model guard stops this API; the
 * role guard stops everything else on the same credentials.
 */
const CreditLedgerSchema = appendOnly(
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      batchId: { ...ref('CreditBatch', { required: true }), required: true },
      txnType: {
        type: String,
        required: true,
        enum: ['ISSUE', 'TRADE_IN', 'TRADE_OUT', 'RETIRE', 'EXPIRE', 'ADJUST'],
      },
      quantity: { type: Number, required: true }, // signed
      refTradeId: { ...ref('Trade'), default: null },
      refRetirementId: { ...ref('CreditRetirement'), default: null },
      createdAt: nowDate,
    },
    { ...base, collection: 'creditledger' },
  ),
  'creditledger',
);

// quantity <> 0, from the SQL CHECK. A zero entry makes the running total work
// but records no movement, so it is always a bug.
check(
  CreditLedgerSchema,
  'quantity',
  (doc) => doc.quantity !== 0 || 'quantity must not be zero: a zero entry records no movement',
);
const CreditLedger = mongoose.model('CreditLedger', CreditLedgerSchema);

// Holdings per company: the derived balance is a sum over this index.
CreditLedger.schema.index({ companyId: 1, batchId: 1 });
CreditLedger.schema.index({ companyId: 1, createdAt: -1 });
// Finding the batches that still owe an expiry offset, and trade allocations.
CreditLedger.schema.index({ txnType: 1, batchId: 1 });
CreditLedger.schema.index({ refTradeId: 1, txnType: 1 });

/**
 * Credits surrendered against a compliance obligation.
 *
 * periodId is nullable: a voluntary retirement may be made outside any
 * compliance year, and fn_credit_retire in the SQL version allowed that.
 */
const CreditRetirement = mongoose.model(
  'CreditRetirement',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod'), default: null },
      batchId: { ...ref('CreditBatch', { required: true }), required: true },
      quantity: { ...positive, required: true },
      retiredAt: nowDate,
    },
    { ...base, collection: 'creditretirements' },
  ),
);
CreditRetirement.schema.index({ companyId: 1, retiredAt: -1 });
CreditRetirement.schema.index({ periodId: 1 });

/**
 * Fines for exceeding a cap.
 *
 * one per (company, period) — the unique index is what stops a repeated
 * compliance run from stacking penalties.
 */
const Penalty = mongoose.model(
  'Penalty',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod', { required: true }), required: true },
      excessTonnes: { ...positive, required: true },
      ratePerTonne: { type: Number, required: true },
      fineAmount: { type: Number, required: true, min: 0 },
      status: { type: String, required: true, enum: ['UNPAID', 'PAID', 'WAIVED'], default: 'UNPAID' },
      issuedAt: nowDate,
    },
    { ...base, collection: 'penalties' },
  ),
);
Penalty.schema.index({ companyId: 1, periodId: 1 }, { unique: true });
Penalty.schema.index({ status: 1, companyId: 1 });

module.exports = {
  OffsetProject,
  CreditBatch,
  CreditAccount,
  CreditLedger,
  CreditRetirement,
  Penalty,
};
