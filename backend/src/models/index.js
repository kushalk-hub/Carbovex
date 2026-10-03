'use strict';

/**
 * Every model, in one place.
 *
 * Importing models from here rather than from individual files matters: a Mongoose
 * model registers itself globally on first require, and importing the same
 * schema from two paths throws OverwriteModelError. One barrel keeps that from
 * happening.
 */

const reference = require('./reference');
const tenancy = require('./tenancy');
const emissions = require('./emissions');
const reporting = require('./reporting');
const credits = require('./credits');
const market = require('./market');

module.exports = {
  // reference
  Country: reference.Country,
  State: reference.State,
  City: reference.City,
  Sector: reference.Sector,
  Verifier: reference.Verifier,
  FacilityType: reference.FacilityType,
  FuelType: reference.FuelType,
  Registry: reference.Registry,
  ProjectType: reference.ProjectType,
  EmissionSource: reference.EmissionSource,
  CompliancePeriod: reference.CompliancePeriod,

  // tenancy
  Company: tenancy.Company,
  User: tenancy.User,
  Facility: tenancy.Facility,
  FacilityFuel: tenancy.FacilityFuel,
  Sensor: tenancy.Sensor,

  // emissions
  PeriodTotal: emissions.PeriodTotal,
  EmissionReading: emissions.EmissionReading,
  EmissionCap: emissions.EmissionCap,
  Alert: emissions.Alert,

  // reporting
  EmissionReport: reporting.EmissionReport,
  Verification: reporting.Verification,

  // credits
  OffsetProject: credits.OffsetProject,
  CreditBatch: credits.CreditBatch,
  CreditAccount: credits.CreditAccount,
  CreditLedger: credits.CreditLedger,
  CreditRetirement: credits.CreditRetirement,
  Penalty: credits.Penalty,

  // market
  MarketOrder: market.MarketOrder,
  Trade: market.Trade,
  Payment: market.Payment,
  PriceHistory: market.PriceHistory,
  AuditLog: market.AuditLog,

  dedupeKeyFor: emissions.dedupeKeyFor,
};
