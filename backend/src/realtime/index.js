'use strict';

/**
 * Realtime entry point: wires the socket server and the change-stream bridge
 * together, and re-exports the emit facade that route handlers use.
 *
 * Two mechanisms feed the same events, and the second exists because the first
 * cannot be relied on alone:
 *
 *   change streams  catches writes from *any* process — another instance, a
 *                   script, mongosh. This is strictly more capable than the
 *                   PostgreSQL LISTEN/NOTIFY it replaces, which only ever saw
 *                   NOTIFYs issued by this application.
 *   local emit      called directly by the service after it commits. Always
 *                   available, and the reason a single-instance deployment works
 *                   on a standalone mongod.
 *
 * Both publish identical payloads, so a client cannot tell which path delivered
 * an event. The cost of the local emit is that an in-process write is announced
 * twice when change streams are also running, so every emit is deduplicated by
 * event id in socket.js. Duplicates are preferable to a gap.
 */

const socket = require('./socket');
const changeStream = require('./changeStream');

/**
 * @param {import('http').Server} httpServer
 * @param {{ listen?: boolean }} [options] `listen: false` for tests.
 */
async function initRealtime(httpServer, options = {}) {
  socket.attachSocket(httpServer);

  // The local-emit path is wired first and unconditionally, so trades made by
  // this process are always broadcast even if change streams are unavailable.
  changeStream.wireLocalEmits();

  if (options.listen === false) return;

  try {
    await changeStream.start();
  } catch (err) {
    // Realtime is an enhancement, not a prerequisite. The REST API is fully
    // correct without it, so a failure here must not stop the server booting —
    // and the local-emit path above means the UI is still live for this process.
    console.error(
      '[realtime] change streams unavailable, falling back to local emits:',
      err.message,
    );
    changeStream.scheduleReconnect();
  }
}

async function stopRealtime() {
  await changeStream.stop();
  await socket.detachSocket();
}

module.exports = {
  ...socket,
  initRealtime,
  stopRealtime,
  isListening: changeStream.isWatching,
};
