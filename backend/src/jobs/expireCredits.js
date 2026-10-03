'use strict';

/** Expire outstanding batches through the transactional credits service. */

const { CreditLedger, Company } = require('../models');
const credits = require('../services/credits');
const realtime = require('../realtime');
const log = (...args) => console.log('[job:expiry]', ...args);

async function expireCredits({ now = new Date() } = {}) {
  const currentYear = now.getUTCFullYear();
  // Capture affected companies before the service writes offsetting EXPIRE legs.
  const rows = await CreditLedger.aggregate([
    { $lookup: { from: 'creditbatches', localField: 'batchId', foreignField: '_id', as: 'batch' } },
    { $unwind: '$batch' },
    { $match: { 'batch.status': 'ACTIVE', 'batch.expiryYear': { $ne: null, $lt: currentYear } } },
    { $group: { _id: { companyId: '$companyId', batchId: '$batchId' }, qty: { $sum: '$quantity' } } },
    { $match: { qty: { $gt: 0 } } },
    { $group: { _id: '$_id.companyId' } },
  ]).exec();

  const affected = rows.length
    ? await Company.find({ _id: { $in: rows.map((row) => row._id) } }).select('name').lean()
    : [];
  const expired = await credits.expireCredits({ now });

  if (expired > 0) {
    log(`${expired} company/batch holding(s) expired`);
    for (const company of affected) {
      realtime.emitToCompany(company._id, 'credits:expired', {
        company: company.name,
        message: 'One or more of your credit batches have passed their expiry year',
      });
    }
    realtime.emitToAll('credits:expired', { count: expired });
  }

  return { expired, affectedCompanies: affected.length };
}

module.exports = { expireCredits };
