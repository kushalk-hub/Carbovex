'use strict';

/**
 * Reference data. Small, read-only, seeded by scripts/seed.js.
 *
 * City coordinates are denormalised onto the city document (stateName, country)
 * because the 3D globe needs to plot every facility without a join, and these
 * tables change about once a year.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, check } = require('./helpers');

const Country = mongoose.model(
  'Country',
  new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
      isoCode: { type: String, required: true, unique: true, uppercase: true, minlength: 2, maxlength: 2 },
    },
    { ...base, collection: 'countries' },
  ),
);

const State = mongoose.model(
  'State',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      countryId: { ...ref('Country', { required: true }), required: true },
    },
    { ...base, collection: 'states' },
  ),
);
// The SQL version was UNIQUE (country_id, name).
State.schema.index({ countryId: 1, name: 1 }, { unique: true });

const City = mongoose.model(
  'City',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      stateId: { ...ref('State'), default: null },
      // Denormalised so the globe needs no $lookup.
      stateName: { type: String, default: null },
      countryIso: { type: String, default: 'IN' },
      latitude: { type: Number, min: -90, max: 90, default: null },
      longitude: { type: Number, min: -180, max: 180, default: null },
    },
    { ...base, collection: 'cities' },
  ),
);
City.schema.index({ stateId: 1, name: 1 }, { unique: true });
City.schema.index({ latitude: 1, longitude: 1 });

const Sector = mongoose.model(
  'Sector',
  new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
      description: { type: String, default: null },
    },
    { ...base, collection: 'sectors' },
  ),
);

const Verifier = mongoose.model(
  'Verifier',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      accreditationNo: { type: String, required: true, unique: true, trim: true },
    },
    { ...base, collection: 'verifiers' },
  ),
);

const FacilityType = mongoose.model(
  'FacilityType',
  new mongoose.Schema(
    { name: { type: String, required: true, unique: true, trim: true } },
    { ...base, collection: 'facilitytypes' },
  ),
);

const FuelType = mongoose.model(
  'FuelType',
  new mongoose.Schema(
    {
      name: { type: String, required: true, unique: true, trim: true },
      unit: { type: String, required: true, trim: true }, // tonne, m3, kL, MWh
      // tCO2 per unit of fuel
      emissionFactor: { ...nonNegative, required: true },
    },
    { ...base, collection: 'fueltypes' },
  ),
);

const Registry = mongoose.model(
  'Registry',
  new mongoose.Schema(
    { name: { type: String, required: true, unique: true, trim: true } }, // Verra, Gold Standard, India CCTS
    { ...base, collection: 'registries' },
  ),
);

const ProjectType = mongoose.model(
  'ProjectType',
  new mongoose.Schema(
    { name: { type: String, required: true, unique: true, trim: true } }, // Solar, Wind, Reforestation, Biogas
    { ...base, collection: 'projecttypes' },
  ),
);

/**
 * Emission sources: scope 1/2/3.
 *
 * scope is a SMALLINT in the SQL. Here it stays a Number with an enum, because
 * it is a closed set defined by the GHG Protocol, not a free number.
 */
const EmissionSource = mongoose.model(
  'EmissionSource',
  new mongoose.Schema(
    {
      scope: { type: Number, required: true, enum: [1, 2, 3] },
      name: { type: String, required: true, trim: true },
    },
    { ...base, collection: 'emissionsources' },
  ),
);

/**
 * Compliance periods — one calendar year each.
 *
 * The trigger-guaranteed alert and cap uniqueness keyed on period, so this
 * collection is small, bounded, and effectively immutable once a year has
 * closed. Guarded accordingly.
 */
const CompliancePeriod = mongoose.model(
  'CompliancePeriod',
  check(
    new mongoose.Schema(
      {
        year: { type: Number, required: true, unique: true, min: 2000, max: 2200 },
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        deadline: { type: Date, required: true },
        status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
      },
      { ...base, collection: 'complianceperiods' },
    ),
    'endDate', // endDate > startDate, from the SQL CHECK.
    (doc) => doc.endDate > doc.startDate || 'endDate must be after startDate',
  ),
);

module.exports = {
  Country,
  State,
  City,
  Sector,
  Verifier,
  FacilityType,
  FuelType,
  Registry,
  ProjectType,
  EmissionSource,
  CompliancePeriod,
};
