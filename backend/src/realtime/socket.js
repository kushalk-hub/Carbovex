'use strict';

/**
 * Socket.IO server and the emit facade used by every route handler.
 *
 * Route handlers import from here, never from socket.io directly, so that
 * (a) room naming stays in one place and
 * (b) tests can exercise handlers with realtime switched off — every emit is a
 *     no-op when `io` is null.
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

let io = null;

/**
 * Room naming, so a socket only ever receives what it is entitled to:
 *   global          every authenticated socket
 *   role:ADMIN      one role
 *   company:12      that company's private data (wallet, alerts, own orders)
 *   facility:17     one globe marker
 *   sector:Power    one sector leaderboard
 */
const ROOM_GUARD = /^[a-z_]{1,32}$/;

/** The only channels a client may subscribe to. */
const SUBSCRIBABLE = ['facility', 'company', 'sector'];

function attachSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
    // The polling fallback matters: corporate networks and some Indian ISPs
    // break WebSockets, and a silently dead live dashboard is worse than a
    // polled one.
    transports: ['websocket', 'polling'],
  });

  // Authenticate during the handshake, so an unauthenticated client can never
  // subscribe to any feed.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, '');
    if (!token) return next(new Error('Missing token'));

    let claims;
    try {
      claims = jwt.verify(token, env.jwtSecret, { issuer: 'carbonx' });
    } catch {
      return next(new Error('Invalid or expired token'));
    }

    socket.data.userId = claims.sub;
    socket.data.companyId = claims.companyId ?? null;
    socket.data.role = claims.role;
    return next();
  });

  io.on('connection', (socket) => {
    const { userId, companyId, role } = socket.data;
    socket.join('global');
    socket.join(`role:${role}`);
    if (companyId) socket.join(`company:${companyId}`);

    const rooms = [...socket.rooms].filter((r) => r !== socket.id);
    socket.emit('connected', { userId, companyId, role, rooms });

    /** Narrow to a single feed, e.g. subscribe('facility', 17). */
    socket.on('subscribe', (channel, value) => {
      // Allowlist, not a blocklist: an unknown channel is refused, so adding a
      // new socket event can never accidentally expose a private room.
      if (!SUBSCRIBABLE.includes(channel)) return;
      if (typeof value !== 'string' && typeof value !== 'number') return;
      const room = `${channel}:${String(value).slice(0, 64)}`;

      // A company may only follow its own private room.
      if (channel === 'company' && Number(value) !== Number(companyId)) return;

      socket.join(room);
      socket.emit('subscribed', { room });
    });

    socket.on('unsubscribe', (channel, value) => {
      if (!SUBSCRIBABLE.includes(channel)) return;
      socket.leave(`${channel}:${String(value).slice(0, 64)}`);
    });
  });

  return io;
}

function detachSocket() {
  if (!io) return Promise.resolve();
  const closing = io;
  io = null;
  return new Promise((resolve) => closing.close(resolve));
}

// ---------------------------------------------------------------------------
// Emit facade. All safe to call when no socket server is running.
// ---------------------------------------------------------------------------

function emitToAll(event, payload) {
  io?.to('global').emit(event, payload);
}

function emitToCompany(companyId, event, payload) {
  if (companyId == null) return;
  io?.to(`company:${companyId}`).emit(event, payload);
}

function emitToRole(role, event, payload) {
  io?.to(`role:${role}`).emit(event, payload);
}

function emitToRoom(room, event, payload) {
  io?.to(room).emit(event, payload);
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Recent event ids, so an event seen twice is delivered once.
 *
 * Needed because an in-process write is announced twice when change streams are
 * also running: once by the service's local emit and once by the change stream
 * watching the same collection. Both payloads are identical, so a client that
 * rendered both would see a duplicate trade or a doubled counter.
 *
 * A bounded set with a sweep, rather than a growing list, because this runs on
 * every event for the life of the process. The window only needs to be long
 * enough to catch the near-simultaneous arrival of the same event; the two
 * paths fire within milliseconds of each other.
 */
const seenEventIds = new Set();
const EVENT_ID_TTL_MS = 5_000;
const EVENT_ID_MAX = 5000;
let lastSweep = 0;

function isDuplicate(eventId) {
  if (!eventId) return false;
  const now = Date.now();

  if (now - lastSweep > EVENT_ID_TTL_MS) {
    lastSweep = now;
    // Rebuild rather than expire in place: the set holds bare ids, so a true
    // LRU would need a Map. A hard cap plus periodic rebuild is simpler and
    // good enough for a 5-second window.
    if (seenEventIds.size > EVENT_ID_MAX) seenEventIds.clear();
  }

  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  return false;
}

/**
 * Emit an event at most once per event id.
 *
 * Callers pass an id derived from the underlying document — the ObjectId of the
 * trade, or a hash of the reading's dedupe key. Using the document's own
 * identity rather than a generated one is what makes the two delivery paths
 * agree: both derive the id from the same written document.
 */
function emitOnce(eventId, event, payload, deliver = emitToAll) {
  if (isDuplicate(eventId)) return false;
  deliver(event, payload);
  return true;
}

/** A live reading: to that facility's watchers, and to the globe generally. */
function emitReading(facilityId, reading) {
  emitToRoom(`facility:${facilityId}`, 'reading:new', reading);
  emitToAll('globe:update', reading);
}

/** The order book is market-wide, so it goes to everyone. */
function emitOrderBook(snapshot) {
  emitToAll('orderbook:update', snapshot);
}

/** Wallet and holdings changed for one company only. */
function emitWallet(companyId, snapshot) {
  emitToCompany(companyId, 'wallet:update', snapshot);
}

module.exports = {
  attachSocket,
  detachSocket,
  emitToAll,
  emitToCompany,
  emitToRole,
  emitToRoom,
  emitOnce,
  isDuplicateEvent: isDuplicate,
  emitReading,
  emitOrderBook,
  emitWallet,
  isActive: () => io !== null,
};
