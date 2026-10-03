'use strict';

/**
 * Express application factory.
 *
 * Exported separately from server.js so tests can mount the app on an ephemeral
 * port and drive it with fetch, without a real listen() or a real database.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const env = require('./config/env');
const db = require('./db/connect');
const { errorHandler, notFoundHandler, errors } = require('./middleware/errors');
const { apiLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./modules/auth/routes');
const statsRoutes = require('./modules/stats/routes');
const companyRoutes = require('./modules/companies/routes');
const facilityRoutes = require('./modules/facilities/routes');
const readingRoutes = require('./modules/readings/routes').router;
const marketRoutes = require('./modules/market/routes');
const walletRoutes = require('./modules/wallet/routes');
const reportRoutes = require('./modules/reports/routes');
const alertRoutes = require('./modules/alerts/routes');
const projectRoutes = require('./modules/projects/routes');
const adminRoutes = require('./modules/admin/routes');
const auditRoutes = require('./modules/audit/routes');

function createApp() {
  const app = express();

  // Behind a load balancer, req.ip must come from X-Forwarded-For or every
  // client looks like the proxy and the rate limiter lumps them together.
  //
  // Only when one is actually declared. `trust proxy` makes Express believe
  // X-Forwarded-For, which is a client-controlled header: with it on in local
  // development, anyone can send a different one on every request and walk
  // straight through the rate limiter. An explicit hop count is safer than
  // `true`, which would trust the whole chain.
  const proxyHops = env.trustProxyHops;
  if (proxyHops > 0) {
    app.set('trust proxy', proxyHops);
  } else if (env.isProduction) {
    // Production without an explicit setting is the dangerous default, so fail
    // loudly rather than silently trusting a client-supplied header.
    throw new Error(
      'TRUST_PROXY_HOPS must be set to the number of proxies in front of the app when NODE_ENV=production',
    );
  }
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP here would break the docs
      // page without protecting anything.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients send no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigin.includes(origin)) return callback(null, true);
        return callback(errors.forbidden(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );

  // 1 MB: the largest legitimate ingest body is 1000 readings, which is ~60 KB.
  app.use(express.json({ limit: '1mb' }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? 'combined' : 'dev'));
  }

  // ---- health ------------------------------------------------------------
  // Before the rate limiter, so a monitor cannot be throttled out of checking.
  app.get('/health', async (req, res) => {
    let database = 'down';
    // The old pg version asked SELECT 1. Here a ping is the same idea, and the
    // replica-set flag is reported alongside because it is not merely
    // informational: on a standalone the API boots fine and every write that
    // needs a transaction fails at runtime. A monitor that can see it is a
    // monitor that can alert before a trade does.
    let transactions = false;
    try {
      await db.mongoose.connection.db.admin().command({ ping: 1 });
      database = 'up';
      transactions = await db.supportsTransactions();
    } catch {
      database = 'down';
    }

    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      // False on a standalone: reachable, but the trading and compliance paths
      // cannot run. Reported rather than fatal so a health check still works.
      transactions,
      uptime: Math.round(process.uptime()),
      env: env.NODE_ENV,
      time: new Date().toISOString(),
    });
  });

  app.get('/', (req, res) => {
    res.json({
      name: 'CarbonX API',
      version: '1.0.0',
      docs: 'See backend/README.md',
      health: '/health',
    });
  });

  // ---- API ---------------------------------------------------------------
  app.use('/api', apiLimiter);

  app.use('/api/auth', authRoutes.router);
  app.use('/api/stats', statsRoutes);
  app.use('/api/companies', companyRoutes);
  app.use('/api/facilities', facilityRoutes);
  app.use('/api/readings', readingRoutes);
  // One router owns both /api/market/* and /api/orders*, so it is mounted once
  // at /api. Mounting it twice would make Express match /api/orders through the
  // /api/market mount and skip the rest of the stack.
  app.use('/api', marketRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api', alertRoutes);
  app.use('/api', adminRoutes);
  app.use('/api/audit-log', auditRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
