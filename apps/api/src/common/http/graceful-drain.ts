import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

/**
 * Zero-loss shutdown of the HTTP side, for deploys. This is a money system:
 * no request may be dropped while the API container is swapped.
 *
 * Why it is needed. Caddy keeps a pool of keep-alive connections to the API and
 * reuses them all the time. Node's server.close() stops accepting NEW
 * connections but waits for every open one to end, and a connection that keeps
 * carrying requests never ends. Measured on staging (2026-10-13): the old API
 * was still running when Docker killed it 10s after SIGTERM. Closing those
 * connections ourselves is not enough on its own either: Caddy could be
 * writing a new request onto a pooled connection at the very moment we close
 * it, and a request that was already sent cannot be retried safely.
 *
 * So the order is:
 *   1. `shutdownState.draining` turns on: /v1/health answers 503, and every
 *      response carries `Connection: close`. Caddy's active health check (every
 *      second, see the Caddyfile) stops routing new requests here and HOLDS
 *      them (lb_try_duration) until the new container is healthy.
 *   2. After LB_NOTICE_MS, when Caddy has stopped sending here, the server stops
 *      accepting and closes its idle connections — nothing is being written to
 *      them any more.
 *   3. Requests still in flight run to completion. Only a request still running
 *      after DRAIN_DEADLINE_MS is cut, so a stuck one cannot outlive Docker's
 *      stop_grace_period (docker-compose: 60s).
 * The caller (main.ts) stops the background jobs alongside, and closes the
 * database and Redis only after both are done.
 */
export const shutdownState = { draining: false };

/** Caddy health-checks every 1s; this is how long it gets to notice the 503. */
export const LB_NOTICE_MS = 3_000;
/** In-flight requests get this long in total; Docker's stop_grace_period is longer. */
export const DRAIN_DEADLINE_MS = 40_000;

/** Express middleware, mounted first: once draining, every response closes its connection. */
export function drainMiddleware(_req: Request, res: Response, next: NextFunction): void {
  if (shutdownState.draining) res.setHeader('Connection', 'close');
  next();
}

type DrainableServer = Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drain the HTTP server (see above). Resolves once every connection has closed.
 * `noticeMs` / `deadlineMs` are injectable for tests.
 */
export async function drainHttpServer(
  server: DrainableServer,
  { noticeMs = LB_NOTICE_MS, deadlineMs = DRAIN_DEADLINE_MS } = {},
): Promise<void> {
  shutdownState.draining = true;
  await sleep(noticeMs);
  await new Promise<void>((resolve) => {
    // Stop accepting; the callback fires once every connection has closed.
    server.close(() => resolve());
    server.closeIdleConnections();
    // Backstop for a request that never finishes.
    setTimeout(() => server.closeAllConnections(), Math.max(0, deadlineMs - noticeMs)).unref();
  });
}
