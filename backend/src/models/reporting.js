'use strict';

/**
 * Reporting: filings and verifications.
 *
 * Both collections are append-once-per-entity: a company files one report per
 * period, and a report is verified once. Those rules were UNIQUE constraints in
 * SQL and are compound unique indexes here.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, nowDate } = require('./helpers');

const EmissionReport = mongoose.model(
  'EmissionReport',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      periodId: { ...ref('CompliancePeriod', { required: true }), required: true },
      totalTonnes: { ...nonNegative, required: true },
      status: {
        type: String,
        required: true,
        enum: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED'],
        default: 'DRAFT',
      },
      submittedAt: { type: Date, default: null },
    },
    { ...base, collection: 'emissionreports' },
  ),
);
EmissionReport.schema.index({ companyId: 1, periodId: 1 }, { unique: true });
// The auditor worklist: everything still waiting, oldest first.
EmissionReport.schema.index({ status: 1, submittedAt: 1 });

/**
 * The decision on a report.
 *
 * One per report — the unique index on reportId is what stops two auditors
 * clicking Approve at the same time from both inserting a decision. The service
 * re-checks the report's status inside the transaction as well, because an
 * index alone is not enough: it would turn the race into a duplicate-key error
 * rather than a clean "already verified".
 *
 * `verifierId` points at the accreditation *body* (the Verra-style verifier),
 * not the user account. The individual who clicked the button is deliberately
 * not stored here: it is captured in the audit log, which is the record designed
 * to answer "who did this". An account with no accreditation of its own — an
 * ADMIN — is attributed to the seeded internal reviewer rather than to an
 * arbitrary real body.
 */
const Verification = mongoose.model(
  'Verification',
  new mongoose.Schema(
    {
      reportId: { ...ref('EmissionReport', { required: true }), required: true },
      verifierId: { ...ref('Verifier', { required: true }), required: true },
      decision: { type: String, required: true, enum: ['APPROVED', 'REJECTED'] },
      remarks: { type: String, default: null },
      verifiedAt: nowDate,
    },
    { ...base, collection: 'verifications' },
  ),
);
Verification.schema.index({ reportId: 1 }, { unique: true });
Verification.schema.index({ verifierId: 1, verifiedAt: -1 });

module.exports = { EmissionReport, Verification };
