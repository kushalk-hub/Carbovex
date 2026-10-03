'use strict';

/** Daily OHLCV maintenance. Monthly readings aggregate on demand in MongoDB. */

const pricing = require('../services/pricing');

async function refreshPriceHistory(day = new Date()) {
  return pricing.refreshPriceHistory(day);
}

/** Keep today's partial candle out of the completed daily history. */
async function runDaily({ day = new Date(Date.now() - 86_400_000) } = {}) {
  return { price: await refreshPriceHistory(day) };
}

module.exports = { runDaily, refreshPriceHistory };
