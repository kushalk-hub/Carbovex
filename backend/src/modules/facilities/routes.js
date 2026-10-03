'use strict';

/**
 * GET /api/facilities                globe data
 * GET /api/facilities/:id            detail
 * GET /api/facilities/:id/readings   time series
 *
 * The list endpoint is the one that matters most: it is the entire 3D globe.
 */

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { validate, schemas, q } = require('../../middleware/validate');
const { errors } = require('../../middleware/errors');
const {
  Facility,
  Company,
  Sector,
  City,
  FacilityType,
  FacilityFuel,
  FuelType,
  Sensor,
  EmissionReading,
  PeriodTotal,
  CompliancePeriod,
  EmissionCap,
} = require('../../models');
const { aggregations } = require('../../services');

const router = express.Router();

function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/** Case-insensitive substring, regex-escaped. See the note in companies/routes. */
function searchPattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * GET /api/facilities?year=&sector=&state=&search=&onlyOverCap=
 *
 * Facilities without coordinates are filtered in the pipeline, not in JavaScript.
 * Sending nulls and letting the globe skip them produces a silently empty planet,
 * which is the single most confusing failure this project can have — so the
 * $match comes first and the planet can never be built from unplaceable points.
 *
 * The SQL did this with CTEs for the per-company totals and caps. Here those are
 * $lookup sub-pipelines keyed on the target period, so a facility's emitted and
 * cap figures arrive with the facility rather than in a separate pass that then
 * has to be joined by hand in JavaScript.
 */
router.get(
  '/',
  requireAuth,
  validate(schemas.facilityQuery, 'query'),
  async (req, res, next) => {
    try {
      const { year, sector, state, search, onlyOverCap } = q(req);
      const targetYear = year ?? new Date().getUTCFullYear();

      const rows = await Facility.aggregate([
        // Placed first, and unconditionally: a facility the globe cannot position
        // must never reach the client.
        { $match: { latitude: { $ne: null }, longitude: { $ne: null } } },

        { $lookup: { from: 'companies', localField: 'companyId', foreignField: '_id', as: 'company' } },
        { $unwind: { path: '$company', preserveNullAndEmptyArrays: false } },
        { $lookup: { from: 'sectors', localField: 'company.sectorId', foreignField: '_id', as: 'sector' } },
        { $lookup: { from: 'cities', localField: 'cityId', foreignField: '_id', as: 'city' } },
        { $lookup: { from: 'facilitytypes', localField: 'facilityTypeId', foreignField: '_id', as: 'facilityType' } },

        // Emitted and cap for the target year, per company.
        lookupForYear('periodtotals', 'companyId', targetYear, 'emittedByYear'),
        lookupForYear('emissioncaps', 'companyId', targetYear, 'capsByYear'),

        // A correlated count, since $lookup cannot aggregate.
        {
          $lookup: {
            from: 'sensors',
            localField: '_id',
            foreignField: 'facilityId',
            pipeline: [{ $count: 'n' }],
            as: 'sensorCount',
          },
        },

        // Filters that need a resolved value, so they cannot be in the leading
        // $match. Built as explicit stages rather than a $expr so the sector and
        // state indexes stay usable.
        ...(sector ? [{ $match: { 'sector.name': sector } }] : []),
        ...(state ? [{ $match: { 'city.stateName': state } }] : []),
        ...(search
          ? [
              {
                $match: {
                  $or: [
                    { name: searchPattern(search) },
                    { 'company.name': searchPattern(search) },
                  ],
                },
              },
            ]
          : []),

        {
          $project: {
            _id: 0,
            id: '$_id',
            name: 1,
            latitude: 1,
            longitude: 1,
            status: 1,
            capacityMw: 1,
            companyId: '$companyId',
            company: '$company.name',
            sector: { $ifNull: [{ $first: '$sector.name' }, null] },
            state: { $ifNull: [{ $first: '$city.stateName' }, null] },
            city: { $ifNull: [{ $first: '$city.name' }, null] },
            facilityType: { $ifNull: [{ $first: '$facilityType.name' }, null] },
            emitted: { $ifNull: [{ $first: '$emittedByYear.tonnes' }, 0] },
            cap: { $ifNull: [{ $first: '$capsByYear.capTonnes' }, null] },
            sensorCount: { $ifNull: [{ $first: '$sensorCount.n' }, 0] },
          },
        },
        {
          $addFields: {
            // COALESCE(t.emitted, 0) / NULLIF(ca.cap, 0): a null cap means the
            // company has no cap for that year, which is not the same as 0% use.
            pctUsed: {
              $cond: [
                { $or: [{ $eq: ['$cap', null] }, { $lte: ['$cap', 0] }] },
                null,
                { $round: [{ $multiply: [{ $divide: ['$emitted', '$cap'] }, 100] }, 1] },
              ],
            },
          },
        },
        // "Over cap" only means something when a cap exists, so a company with no
        // cap is never counted as breaching.
        ...(onlyOverCap ? [{ $match: { cap: { $ne: null }, $expr: { $gt: ['$emitted', '$cap'] } } }] : []),

        { $sort: { _id: 1 } },
        { $limit: 5000 },
      ]).exec();

      res.json({
        year: targetYear,
        count: rows.length,
        // Longitude/latitude bounds let the globe frame itself without a second
        // pass over the array on the client. Seeded at the inverted extremes so
        // the first Math.min/max does the right thing.
        bounds: rows.reduce(
          (acc, f) => ({
            minLat: Math.min(acc.minLat, f.latitude),
            maxLat: Math.max(acc.maxLat, f.latitude),
            minLng: Math.min(acc.minLng, f.longitude),
            maxLng: Math.max(acc.maxLng, f.longitude),
          }),
          { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 },
        ),
        facilities: rows,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** A $lookup restricted to documents belonging to a given compliance year. */
function lookupForYear(collection, localField, year, as) {
  return {
    $lookup: {
      from: collection,
      let: { company: `$${localField}` },
      pipeline: [
        { $match: { $expr: { $eq: [`$${localField}`, '$$company'] } } },
        // Join the period to filter on year without a second lookup.
        {
          $lookup: {
            from: 'complianceperiods',
            localField: 'periodId',
            foreignField: '_id',
            as: 'period',
          },
        },
        { $unwind: '$period' },
        { $match: { 'period.year': year } },
        { $project: { periodId: 1, tonnes: 1, capTonnes: 1 } },
      ],
      as,
    },
  };
}

/** GET /api/facilities/:id — detail, fuels, sensors and recent readings. */
router.get(
  '/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const facilityId = objectId(req.params.id, 'id');

      const facility = await Facility.findById(facilityId)
        .populate({ path: 'companyId', select: 'name sectorId' })
        .populate({ path: 'cityId', select: 'name stateName' })
        .populate({ path: 'facilityTypeId', select: 'name' })
        .lean();
      if (!facility) return next(errors.notFound(`Facility ${facilityId} does not exist`));

      // The sector lives on the company, not the facility, so it needs its own
      // lookup rather than a nested populate.
      const sectorDoc = facility.companyId?.sectorId
        ? await Sector.findById(facility.companyId.sectorId).select('name').lean()
        : null;

      const [fuels, sensors, emissions, readings, capHistory] = await Promise.all([
        // impliedTonnes = annualConsumption * emissionFactor, computed in the
        // pipeline rather than round-tripping to JS.
        FacilityFuel.aggregate([
          { $match: { facilityId: facility._id } },
          { $lookup: { from: 'fueltypes', localField: 'fuelId', foreignField: '_id', as: 'fuel' } },
          { $unwind: '$fuel' },
          {
            $project: {
              _id: 0,
              fuelId: '$fuel._id',
              name: '$fuel.name',
              unit: '$fuel.unit',
              emissionFactor: '$fuel.emissionFactor',
              annualConsumption: 1,
              impliedTonnes: { $multiply: ['$annualConsumption', '$fuel.emissionFactor'] },
            },
          },
        ]).exec(),

        Sensor.find({ facilityId: facility._id })
          .sort({ _id: 1 })
          .select('serialNo sensorType installedOn status lastSeenAt')
          .lean(),

        // Every compliance period, CROSS JOINed as the SQL did so a year with no
        // data still shows as zero rather than vanishing from the history.
        aggregations.facilityEmissionByYear(facility._id),

        EmissionReading.find({ facilityId: facility._id })
          .sort({ readingTs: -1 })
          .limit(30)
          .select('readingTs co2Tonnes verified')
          .lean(),

        EmissionCap.aggregate([
          { $match: { companyId: facility.companyId._id } },
          { $lookup: { from: 'complianceperiods', localField: 'periodId', foreignField: '_id', as: 'period' } },
          { $unwind: '$period' },
          { $lookup: { from: 'periodtotals', localField: 'periodId', foreignField: 'periodId', as: 'total' } },
          {
            $project: {
              _id: 0,
              year: '$period.year',
              cap: '$capTonnes',
              emitted: { $ifNull: [{ $first: '$total.tonnes' }, 0] },
            },
          },
          {
            $addFields: {
              pctUsed: {
                $cond: [
                  { $lte: ['$cap', 0] },
                  null,
                  { $round: [{ $multiply: [{ $divide: ['$emitted', '$cap'] }, 100] }, 1] },
                ],
              },
            },
          },
          { $sort: { year: -1 } },
        ]).exec(),
      ]);

      res.json({
        facility: {
          id: String(facility._id),
          name: facility.name,
          latitude: facility.latitude,
          longitude: facility.longitude,
          capacityMw: facility.capacityMw,
          commissionedYear: facility.commissionedYear,
          baselineAnnualTonnes: facility.baselineAnnualTonnes,
          status: facility.status,
          companyId: String(facility.companyId._id),
          company: facility.companyId?.name ?? null,
          sector: sectorDoc?.name ?? null,
          city: facility.cityId?.name ?? null,
          state: facility.cityId?.stateName ?? null,
          facilityType: facility.facilityTypeId?.name ?? null,
        },
        fuels: fuels.map((f) => ({ ...f, fuelId: String(f.fuelId) })),
        sensors: sensors.map((s) => ({
          id: String(s._id),
          serialNo: s.serialNo,
          sensorType: s.sensorType,
          installedOn: s.installedOn,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
        })),
        emissions,
        readings: readings.map((r) => ({ ts: r.readingTs, tonnes: r.co2Tonnes, verified: r.verified })),
        capHistory,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/facilities/:id/readings?bucket=day|week|month|hour&from=&to=
 *
 * The SQL read bucket=month from a materialised view refreshed nightly, which was
 * the difference between one row per facility per month and one row per day. Here
 * there is no equivalent cache, so month buckets are aggregated on read: a $group
 * over the (facilityId, readingTs) index for a month of data is cheap, and it
 * cannot go stale the way a nightly refresh could.
 */
router.get(
  '/:id/readings',
  requireAuth,
  validate(schemas.readingsQuery, 'query'),
  async (req, res, next) => {
    try {
      const facilityId = objectId(req.params.id, 'id');
      const { bucket, from, to, limit } = q(req);

      const match = { facilityId };
      if (from || to) {
        match.readingTs = {};
        if (from) match.readingTs.$gte = new Date(from);
        // `to` is a calendar date and inclusive in the API, so the range runs to
        // the end of that day.
        if (to) match.readingTs.$lte = new Date(new Date(to).getTime() + 86_400_000 - 1);
      }

      // Truncation units. $dateTrunc exists in MongoDB 5.0+, and the server here
      // is 9.x, so it is used directly rather than hand-rolled with $year/$month.
      // The unit is never user-supplied: `bucket` is a validated enum.
      const unit = { hour: 'hour', day: 'day', week: 'week', month: 'month' }[bucket];

      const rows = await EmissionReading.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateTrunc: { date: '$readingTs', unit, timezone: 'UTC' } },
            tonnes: { $sum: '$co2Tonnes' },
            samples: { $sum: 1 },
            // bool_and in the SQL: a bucket counts as verified only if every
            // reading in it was. $min over booleans is false when any is false.
            verified: { $min: '$verified' },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, ts: '$_id', tonnes: 1, samples: 1, verified: 1 } },
      ]).exec();

      res.json({ facilityId, bucket, readings: rows });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
