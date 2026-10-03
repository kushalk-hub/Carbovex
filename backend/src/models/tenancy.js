'use strict';

/**
 * Tenancy: companies, users, and the facilities/sensors that hang off them.
 */

const mongoose = require('mongoose');
const { base, ref, nonNegative, nowDate, check } = require('./helpers');

const Company = mongoose.model(
  'Company',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      sectorId: { ...ref('Sector'), default: null },
      regNumber: { type: String, default: null, trim: true },
      email: { type: String, default: null, trim: true, lowercase: true },
      phone: { type: String, default: null },
      address: { type: String, default: null },
      status: { type: String, required: true, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
      createdAt: nowDate,
    },
    { ...base, collection: 'companies' },
  ),
);
// Unique when present. In SQL these were UNIQUE and therefore implicitly
// nullable-and-distinct; in MongoDB a `unique` index on a sparse field still
// rejects two documents both holding null, so the filter expression is required.
Company.schema.index({ regNumber: 1 }, { unique: true, partialFilterExpression: { regNumber: { $type: 'string' } } });
Company.schema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
Company.schema.index({ sectorId: 1 });
Company.schema.index({ name: 'text', regNumber: 'text' });

/**
 * Users.
 *
 * The cross-field rule from the SQL CHECK constraint — a COMPANY must have a
 * company, an AUDITOR must have a verifier — becomes a document-level
 * validator, because Mongoose cannot express it as a simple field option.
 */
const User = mongoose.model(
  'User',
  check(
    new mongoose.Schema(
      {
        companyId: { ...ref('Company'), default: null },
        verifierId: { ...ref('Verifier'), default: null },
        fullName: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, trim: true, lowercase: true },
        passwordHash: { type: String, required: true },
        role: { type: String, required: true, enum: ['ADMIN', 'COMPANY', 'AUDITOR'] },
        isActive: { type: Boolean, required: true, default: true },
        createdAt: nowDate,
      },
      { ...base, collection: 'users' },
    ),
    'role',
    // A COMPANY user must belong to a company; an AUDITOR must be accredited.
    // The original spec only enforced the first half, and enforcement lived in a
    // database CHECK that nothing could bypass. This is application-level, so
    // it depends on every user write going through the model.
    (doc) => {
      if (doc.role === 'COMPANY' && !doc.companyId) {
        return 'A COMPANY user must belong to a company';
      }
      if (doc.role === 'AUDITOR' && !doc.verifierId) {
        return 'An AUDITOR user must be linked to an accredited verifier';
      }
      return true;
    },
  ),
);
User.schema.index({ companyId: 1 });
User.schema.index({ role: 1, isActive: 1 });

const Facility = mongoose.model(
  'Facility',
  new mongoose.Schema(
    {
      companyId: { ...ref('Company', { required: true }), required: true },
      cityId: { ...ref('City'), default: null },
      facilityTypeId: { ...ref('FacilityType'), default: null },
      name: { type: String, required: true, trim: true },
      latitude: { type: Number, min: -90, max: 90, default: null },
      longitude: { type: Number, min: -180, max: 180, default: null },
      capacityMw: { ...nonNegative, default: null },
      commissionedYear: { type: Number, min: 1900, max: 2100, default: null },
      baselineAnnualTonnes: { ...nonNegative, default: 0 },
      status: { type: String, required: true, enum: ['ACTIVE', 'IDLE', 'CLOSED'], default: 'ACTIVE' },
    },
    { ...base, collection: 'facilities' },
  ),
);
// The globe query: all facilities, optionally filtered by year, for plotting.
Facility.schema.index({ companyId: 1 });
Facility.schema.index({ cityId: 1 });
Facility.schema.index({ latitude: 1, longitude: 1 });

const FacilityFuel = mongoose.model(
  'FacilityFuel',
  new mongoose.Schema(
    {
      facilityId: { ...ref('Facility', { required: true }), required: true },
      fuelId: { ...ref('FuelType', { required: true }), required: true },
      annualConsumption: { ...nonNegative, required: true },
    },
    { ...base, collection: 'facilityfuels' },
  ),
);
FacilityFuel.schema.index({ facilityId: 1, fuelId: 1 }, { unique: true });

/**
 * Sensors.
 *
 * `apiKeyHash` is sha256 hex, not bcrypt: the ingest path has to match this row
 * on every single request and bcrypt is deliberately slow. The key is
 * high-entropy and machine-generated, so a fast hash is the right trade.
 */
const Sensor = mongoose.model(
  'Sensor',
  new mongoose.Schema(
    {
      facilityId: { ...ref('Facility', { required: true }), required: true },
      serialNo: { type: String, required: true, unique: true, trim: true },
      sensorType: { type: String, required: true, enum: ['CO2', 'CH4', 'N2O', 'FLOW'] },
      apiKeyHash: { type: String, required: true },
      installedOn: { type: Date, default: Date.now },
      status: { type: String, required: true, enum: ['ONLINE', 'OFFLINE', 'FAULTY'], default: 'ONLINE' },
      lastSeenAt: { type: Date, default: null },
    },
    { ...base, collection: 'sensors' },
  ),
);
Sensor.schema.index({ facilityId: 1 });
Sensor.schema.index({ status: 1 });
// Key-only lookup is used by the recent-readings endpoint; ingest also matches
// by _id, whose built-in index narrows the shared demo-key case efficiently.
Sensor.schema.index({ apiKeyHash: 1 });

module.exports = { Company, User, Facility, FacilityFuel, Sensor };
