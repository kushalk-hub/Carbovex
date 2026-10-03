'use strict';

/**
 * Service layer. Every write in the application goes through one of these, which
 * is the structural replacement for the database triggers.
 *
 * Routing:
 *   readings.js     ingest, period totals, compliance runs   (was: trigger + fn_period_compliance)
 *   credits.js      balances, issuing, retiring, expiry      (was: trigger + fn_issue_batch/retire/expire)
 *   trading.js      matching and execution                   (was: fn_execute_trade / fn_match_orders)
 *   pricing.js      daily OHLCV                              (was: fn_refresh_price_history)
 *   aggregations.js the views                                (was: 03_views.sql)
 *   audit.js        the audit trail                          (was: trg_audit)
 */

const aggregations = require('./aggregations');
const audit = require('./audit');
const credits = require('./credits');
const pricing = require('./pricing');
const readings = require('./readings');
const trading = require('./trading');

module.exports = {
  aggregations,
  audit,
  credits,
  pricing,
  readings,
  trading,
};
