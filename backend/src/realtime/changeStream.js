'use strict';

/**
 * Change streams — the replacement for pgListener.js and PostgreSQL LISTEN/NOTIFY.
 *
 * What this is better at than what it replaces: LISTEN/NOTIFY only ever saw
 * NOTIFYs that this application issued explicitly. A change stream sees every
 * committed write to a watched collection, whoever made it — another instance, a
 * script, a mongosh session. So the "someone edited the ledger outside the API"
 * case, which was invisible before, is now visible.
 *
 * What it is worse at, and why the local-emit path still exists:
 *
 *   - it requires a replica set. A standalone mongod rejects it outright.
 *   - it is a cursor that can die, so it needs supervision and reconnection with
 *     resume tokens, or events are silently lost across a primary failover.
 *   - a resume token is only valid for the life of an oplog window, so a long
 *     outage means events before the reconnect are gone for good.
 *
 * Given those, the design is: change streams are the *primary* path when
 * available, and every service also emits locally after it commits. Events are
 * deduplicated in socket.js, so the overlap costs a little CPU and no correctness.
 * A gap would be far worse than a duplicate.
 */

const db = require('../db/connect');
const realtime = require('./socket');
const { MarketOrder } = require('../models');

/** Open change stream cursors, by collection name. */
const streams = new Map();

/** Resume tokens, so a reconnect continues rather than restarting. */
const resumeTokens = new Map();

let watching = false;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Collections worth watching, and what to do with an event on each.
 *
 * Deliberately short. Watching everything would mean streaming the ledger and the
 * readings — the two highest-volume collections in the system — to rebuild
 * summaries the API can compute on read. Only collections where a change is
 * itself the user-visible event belong here.
 */
const WATCHED = {
  trades: onTrade,
  emissionreadings: onReading,
  alerts: onAlert,
  marketorders: onOrderBookDirty,
};

/**
 * A trade was executed.
 *
 * The event id is the trade's own _id, which is what lets the local emit and this
 * stream be deduplicated: both derive the id from the same document.
 */
async function onTrade(change) {
  const trade = change.fullDocument;
  if (!trade) return;

  // The trade document does not carry the counterparty company ids — they live on
  // the two orders — so they are read here to match the payload the local emit in
  // trading.js already sends. The prefix matches too, so the two paths
  // deduplicate against each other.
  const [buy, sell] = await Promise.all([
    MarketOrder.findById(trade.buyOrderId).select('companyId').lean(),
    MarketOrder.findById(trade.sellOrderId).select('companyId').lean(),
  ]);

  realtime.emitOnce(
    `trade:${trade._id}`,
    'trade:executed',
    {
      tradeId: String(trade._id),
      quantity: trade.quantity,
      price: trade.price,
      buyerCompanyId: buy ? String(buy.companyId) : null,
      sellerCompanyId: sell ? String(sell.companyId) : null,
      tradeTs: trade.tradeTs,
    },
  );
}

/** A reading landed. Only insert operations are announced. */
async function onReading(change) {
  if (change.operationType !== 'insert') return;
  const reading = change.fullDocument;
  if (!reading) return;

  // dedupeKey is a natural event id: stable across both delivery paths, and
  // derived from content rather than from a counter.
  realtime.emitOnce(
    `reading:${reading.dedupeKey}`,
    'reading:new',
    {
      id: String(reading._id),
      facilityId: String(reading.facilityId),
      readingTs: reading.readingTs,
      co2Tonnes: reading.co2Tonnes,
      verified: reading.verified,
    },
  );
}

/** A new or re-raised alert. */
async function onAlert(change) {
  if (change.operationType !== 'insert' && change.operationType !== 'update') return;
  const alert = change.fullDocument;
  if (!alert) return;

  realtime.emitToCompany(String(alert.companyId), 'alert:new', {
    id: String(alert._id),
    type: alert.alertType,
    message: alert.message,
    isRead: alert.isRead,
    createdAt: alert.createdAt,
  });
}

/**
 * The book changed.
 *
 * The snapshot is not rebuilt here. Doing so on every single write would mean
 * re-running the aggregation per fill, and a partial fill touches one order
 * while the book has many. Instead this marks the book dirty and pushes a
 * lightweight "something moved" event, and the market route pushes the rebuilt
 * snapshot — the same arrangement the SQL version used with its NOTIFY payload
 * containing only the trade.
 */
async function onOrderBookDirty(change) {
  realtime.emitToAll('orderbook:dirty', { at: change.wallTime ?? new Date() });
}

/**
 * Open a change stream on one collection.
 *
 * `fullDocument: 'updateLookup'` makes MongoDB fetch the post-image for updates
 * and replaces, which onAlert needs. It costs a lookup per event, which is why
 * this is not used for the order book, where only the fact of a change matters.
 */
async function watch(collection) {
  const pipeline = WATCHED[collection] ? undefined : [{ $match: { operationType: 'insert' } }];
  const options = {
    fullDocument: 'updateLookup',
    ...(resumeTokens.has(collection) ? { resumeAfter: resumeTokens.get(collection) } : {}),
  };

  const nativeCollection = db.mongoose.connection.db.collection(collection);
  const stream = nativeCollection
    .watch(pipeline, options)
    .on('change', (change) => {
      // Recorded before dispatch so an exception in a handler cannot cause the
      // same event to be processed twice on reconnection.
      try {
        resumeTokens.set(collection, change._id);
      } catch {
        // Some resume events carry no _id; not an error worth stopping for.
      }
      Promise.resolve(WATCHED[collection](change)).catch((err) => {
        console.error(`[realtime] handler for ${collection} failed:`, err.message);
      });
    })
    .on('error', (err) => {
      console.error(`[realtime] change stream on ${collection} errored:`, err.message);
      // A dead stream must be replaced, not left in the map pretending to work.
      streams.delete(collection);
      scheduleReconnect();
    });

  streams.set(collection, stream);
  return stream;
}

/** Open every watched collection. */
async function start() {
  if (watching) return;

  const supported = await db.supportsChangeStreams();
  if (!supported) {
    throw new Error(
      'Change streams require a replica set. The server is a standalone mongod, so only ' +
        'in-process events will be broadcast. Restart with --replSet to enable cross-process events.',
    );
  }

  for (const collection of Object.keys(WATCHED)) {
    await watch(collection);
  }

  watching = true;
  reconnectDelayMs = 1000;
  console.log(`[realtime] watching ${Object.keys(WATCHED).length} collections`);
}

/** Close every stream. */
async function stop() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const [name, stream] of streams) {
    try {
      await stream.close();
    } catch {
      // Already closed, or the connection is gone. Nothing to recover.
    }
    streams.delete(name);
  }
  watching = false;
}

/**
 * Reopen the streams, with exponential backoff.
 *
 * Backoff rather than an immediate retry, because the usual cause is a primary
 * failover and reconnecting into a replica set that has not chosen a new primary
 * yet just fails again immediately.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      streams.clear();
      await start();
      console.log('[realtime] change streams reconnected');
    } catch (err) {
      console.error(`[realtime] reconnect failed: ${err.message}`);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
      scheduleReconnect();
    }
  }, reconnectDelayMs);

  // Do not hold the process open just to retry a socket.
  if (reconnectTimer.unref) reconnectTimer.unref();
}

/**
 * Tell the trading service to announce its own trades.
 *
 * Called from realtime/index.js rather than at require time, because trading.js
 * requires the aggregation service, which requires models, and importing the
 * socket server from down there would create a cycle. This is the seam that
 * avoids it.
 */
function wireLocalEmits() {
  // Required lazily: see the note above.
  const trading = require('../services/trading');
  trading.setTradeEmitter((trade) => {
    realtime.emitOnce(`trade:${trade.tradeId}`, 'trade:executed', {
      tradeId: String(trade.tradeId),
      quantity: trade.quantity,
      price: trade.price,
      buyerCompanyId: String(trade.buyerCompanyId),
      sellerCompanyId: String(trade.sellerCompanyId),
      tradeTs: trade.tradeTs,
    });
  });
}

module.exports = {
  start,
  stop,
  isWatching: () => watching,
  scheduleReconnect,
  wireLocalEmits,
  WATCHED,
};
