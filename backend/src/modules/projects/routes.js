'use strict';

/**
 * GET  /api/projects             list
 * GET  /api/projects/:id         detail with its batches
 * POST /api/projects/:id/batches issue a batch to the project's owner
 */

const express = require('express');
const { errors } = require('../../middleware/errors');
const { validate, schemas } = require('../../middleware/validate');
const { requireAuth, requireRole, asUserForRequest } = require('../../middleware/auth');
const { OffsetProject, CreditBatch, CreditAccount } = require('../../models');
const { transaction } = require('../../models/helpers');
const { credits } = require('../../services');
const realtime = require('../../realtime');

const router = express.Router();

function objectId(raw, field) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(raw))) {
    throw errors.badRequest(`${field} must be a 24-character hex ObjectId`);
  }
  return raw;
}

/**
 * The city/state pair the SQL built with CONCAT_WS(', ', ...).
 *
 * stateName is denormalised onto the city document, so this needs no second
 * lookup — which is the reason it is denormalised.
 */
function locationOf(city) {
  if (!city) return null;
  return [city.name, city.stateName].filter(Boolean).join(', ') || null;
}

/** GET /api/projects */
router.get(
  '/',
  requireAuth,
  async (req, res, next) => {
    try {
      const projects = await OffsetProject.aggregate([
        { $lookup: { from: 'projecttypes', localField: 'projectTypeId', foreignField: '_id', as: 'projectType' } },
        { $lookup: { from: 'registries', localField: 'registryId', foreignField: '_id', as: 'registry' } },
        { $lookup: { from: 'companies', localField: 'ownerCompanyId', foreignField: '_id', as: 'owner' } },
        { $lookup: { from: 'cities', localField: 'cityId', foreignField: '_id', as: 'city' } },

        // Issued volume per project, from ACTIVE batches only. A $lookup cannot
        // aggregate, so this is a pipeline sub-lookup with a $group inside — the
        // equivalent of the SQL's inline aggregate subquery.
        {
          $lookup: {
            from: 'creditbatches',
            localField: '_id',
            foreignField: 'projectId',
            pipeline: [{ $match: { status: 'ACTIVE' } }, { $group: { _id: null, issued: { $sum: '$quantity' }, batches: { $sum: 1 } } }],
            as: 'issuedTotals',
          },
        },

        { $sort: { name: 1 } },
        {
          $project: {
            _id: 0,
            id: '$_id',
            name: 1,
            location: {
              $let: {
                vars: { city: { $first: '$city' } },
                in: {
                  $switch: {
                    branches: [
                      {
                        case: { $and: [{ $ne: ['$$city.name', null] }, { $ne: ['$$city.stateName', null] }] },
                        then: { $concat: ['$$city.name', ', ', '$$city.stateName'] },
                      },
                      { case: { $ne: ['$$city.name', null] }, then: '$$city.name' },
                    ],
                    default: null,
                  },
                },
              },
            },
            estAnnualCredits: 1,
            startDate: 1,
            status: 1,
            ownerCompanyId: 1,
            ownerCompany: { $ifNull: [{ $first: '$owner.name' }, null] },
            projectType: { $ifNull: [{ $first: '$projectType.name' }, null] },
            registry: { $ifNull: [{ $first: '$registry.name' }, null] },
            issuedTonnes: { $ifNull: [{ $first: '$issuedTotals.issued' }, 0] },
            batchCount: { $ifNull: [{ $first: '$issuedTotals.batches' }, 0] },
          },
        },
        {
          $addFields: {
            // NULLIF(est_annual_credits, 0): a project with no estimate has no
            // meaningful percentage, and dividing would produce Infinity.
            pctIssued: {
              $cond: [
                { $lte: ['$estAnnualCredits', 0] },
                null,
                { $round: [{ $multiply: [{ $divide: ['$issuedTonnes', '$estAnnualCredits'] }, 100] }, 1] },
              ],
            },
          },
        },
      ]).exec();

      res.json({ projects, count: projects.length });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/projects/:id */
router.get(
  '/:id',
  requireAuth,
  async (req, res, next) => {
    try {
      const projectId = objectId(req.params.id, 'id');

      const project = await OffsetProject.findById(projectId)
        .populate({ path: 'projectTypeId', select: 'name' })
        .populate({ path: 'registryId', select: 'name' })
        .populate({ path: 'ownerCompanyId', select: 'name' })
        .populate({ path: 'cityId', select: 'name stateName' })
        .lean();
      if (!project) return next(errors.notFound(`Project ${projectId} does not exist`));

      const batches = await CreditBatch.find({ projectId })
        .sort({ vintageYear: -1, _id: -1 })
        .lean();

      res.json({
        project: {
          id: String(project._id),
          name: project.name,
          location: locationOf(project.cityId),
          estAnnualCredits: project.estAnnualCredits,
          startDate: project.startDate,
          status: project.status,
          ownerCompanyId: String(project.ownerCompanyId),
          ownerCompany: project.ownerCompanyId?.name ?? null,
          projectType: project.projectTypeId?.name ?? null,
          registry: project.registryId?.name ?? null,
        },
        batches: batches.map((b) => ({
          id: String(b._id),
          vintage: b.vintageYear,
          quantity: b.quantity,
          expiresAfter: b.expiryYear ?? null,
          issuedAt: b.issuedAt,
          status: b.status,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/projects/:id/batches
 *
 * Issues a batch to the project's owning company. The route never writes a
 * ledger row or moves a balance itself — credits.issueBatch does both inside one
 * transaction, which is what replaced the fn_issue_batch call plus the
 * ledger_balance trigger behind it.
 */
router.post(
  '/:id/batches',
  requireAuth,
  requireRole('ADMIN'),
  validate(schemas.issueBatch),
  async (req, res, next) => {
    try {
      const projectId = objectId(req.params.id, 'id');
      const { vintage, quantity, expiryYear } = req.body;

      const result = await asUserForRequest(req, () =>
        transaction(async (s) => {
          const project = await OffsetProject.findById(projectId, null, { session: s }).lean();
          if (!project) throw errors.notFound(`Project ${projectId} does not exist`);

          // Do not let the registry's certified volume be quietly exceeded.
          // Checked inside the transaction so a concurrent issue cannot both pass
          // this test and together overshoot the ceiling.
          const issued = await CreditBatch.aggregate(
            [
              { $match: { projectId, status: 'ACTIVE' } },
              { $group: { _id: null, total: { $sum: '$quantity' } } },
            ],
            { session: s },
          ).exec();

          const already = issued.length ? Number(issued[0].total) : 0;
          const ceiling = Number(project.estAnnualCredits);
          if (ceiling > 0 && already + Number(quantity) > ceiling) {
            throw errors.conflict(
              `Issuing ${quantity} would exceed the certified total: ${already} of ${ceiling} already issued`,
            );
          }

          const batch = await credits.issueBatch({
            projectId,
            vintageYear: vintage,
            quantity,
            expiryYear: expiryYear ?? null,
            session: s,
          });

          const wallet = await CreditAccount.findOne({ companyId: project.ownerCompanyId })
            .select('creditBalance cashBalance')
            .session(s)
            .lean();

          return { batch, companyId: project.ownerCompanyId, wallet };
        }),
      );

      realtime.emitWallet(String(result.companyId), result.wallet);
      realtime.emitToAll('project:issued', { projectId, batchId: String(result.batch._id) });

      res.status(201).json({
        batch: {
          id: String(result.batch._id),
          projectId: String(result.batch.projectId),
          vintage: result.batch.vintageYear,
          quantity: result.batch.quantity,
          expiresAfter: result.batch.expiryYear ?? null,
          status: result.batch.status,
          issuedAt: result.batch.issuedAt,
        },
        wallet: result.wallet,
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
