/**
 * Starts the Next.js standalone server (./server.js) so a deploy's SIGTERM
 * finishes in seconds without dropping a page — the web twin of
 * apps/api/src/common/http/graceful-drain.ts. The Dockerfile runs this file.
 *
 * Next's own SIGTERM handler calls server.close() and exits once every
 * connection has closed. Caddy keeps keep-alive connections to it and reuses
 * them all the time, so that close never finished: measured on staging, the old
 * web container ran until Docker killed it 10s after SIGTERM, with requests
 * waiting on it. Here, once SIGTERM arrives, every response carries
 * `Connection: close` (Caddy drops that connection after it, and its next
 * request waits in Caddy's retry window for the new container), idle
 * connections are closed at once, and anything still open after
 * DRAIN_DEADLINE_MS is closed. docker-compose gives the web 30s.
 */
'use strict';
const http = require('node:http');

const DRAIN_DEADLINE_MS = 25_000;
let draining = false;
const servers = new Set();

// Track every HTTP server Next creates, and mark responses once draining.
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'request') {
    servers.add(this);
    if (draining && !args[1].headersSent) args[1].setHeader('Connection', 'close');
  }
  return emit.call(this, event, ...args);
};

function drain() {
  if (draining) return;
  draining = true;
  for (const server of servers) {
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), DRAIN_DEADLINE_MS).unref();
  }
}

// Registered BEFORE Next's own handler (in ./server.js), which then closes the
// server and exits once the connections are gone.
process.on('SIGTERM', drain);
process.on('SIGINT', drain);

require('./server.js');
