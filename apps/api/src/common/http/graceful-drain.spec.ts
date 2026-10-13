import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { drainHttpServer, drainMiddleware, shutdownState, trackUpgrades } from './graceful-drain';

/**
 * A deploy must not lose a single request (money system): while the API
 * shuts down, everything already sent to it is answered, and it closes only
 * once Caddy has stopped routing to it (health 503, see the Caddyfile).
 */
describe('graceful drain', () => {
  afterEach(() => {
    shutdownState.draining = false;
    vi.useRealTimers();
  });

  it('marks responses Connection: close only once draining', () => {
    const res = { setHeader: vi.fn() };
    const next = vi.fn();
    drainMiddleware({} as Request, res as unknown as Response, next as NextFunction);
    expect(res.setHeader).not.toHaveBeenCalled();

    shutdownState.draining = true;
    drainMiddleware({} as Request, res as unknown as Response, next as NextFunction);
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keeps serving through the notice period, then closes; force-closes only at the deadline', async () => {
    vi.useFakeTimers();
    let onClosed = () => {};
    const server = {
      close: vi.fn((cb: () => void) => {
        onClosed = cb;
        return server;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const done = drainHttpServer(server as never, { noticeMs: 3_000, deadlineMs: 40_000 });

    expect(shutdownState.draining).toBe(true);
    // Caddy is still noticing the 503: nothing is closed yet.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(server.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    // A request still running is cut only at the deadline.
    await vi.advanceTimersByTimeAsync(37_000);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    onClosed();
    await expect(done).resolves.toBeUndefined();
  });

  it('a real server under CONTINUOUS keep-alive traffic answers everything sent before it closes', async () => {
    const server = http.createServer((req, res) => {
      drainMiddleware(req as Request, res as unknown as Response, () => res.end('ok'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    // A pool of reused connections with requests always in flight — what
    // Caddy's keep-alive pool to the API looks like under load. (Without Caddy
    // in front, a request sent AFTER the close is refused; Caddy would hold it
    // for the next container. What must never fail is one sent BEFORE.)
    const NOTICE_MS = 300;
    let closeStarted = false;
    const failedBeforeClose: string[] = [];
    let answered = 0;
    let traffic = true;
    const worker = async () => {
      while (traffic) {
        const sentBeforeClose = !closeStarted;
        await fetch(`http://127.0.0.1:${port}/`).then(
          (r) => r.text().then(() => answered++),
          (e: Error) => {
            if (sentBeforeClose) failedBeforeClose.push(e.message);
          },
        );
      }
    };
    const load = Promise.all([worker(), worker(), worker(), worker()]);
    await new Promise((r) => setTimeout(r, 100)); // traffic flowing

    const t0 = Date.now();
    // The notice period ends at NOTICE_MS; mark it a little before, so a request
    // racing the close itself is not counted as "sent before".
    setTimeout(() => {
      closeStarted = true;
    }, NOTICE_MS - 20);
    await drainHttpServer(server, { noticeMs: NOTICE_MS, deadlineMs: 5_000 });
    const tookMs = Date.now() - t0;
    traffic = false;
    await load;

    expect(answered).toBeGreaterThan(0);
    expect(failedBeforeClose).toEqual([]); // nothing sent during the notice period was dropped
    expect(tookMs).toBeLessThan(NOTICE_MS + 1_000); // closes right after the notice, not at the deadline
  });

  it('an open websocket (a dashboard) does not hold the shutdown open', async () => {
    // Measured on staging: one open dashboard kept the old API alive until
    // Docker killed it at 60s — server.close() waits for upgraded sockets too.
    const server = http.createServer((_req, res) => res.end('ok'));
    server.on('upgrade', (_req, socket) => {
      // A realtime connection: accepted, then left open, as socket.io does.
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    trackUpgrades(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    const clientClosed = new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      req.on('upgrade', (_res, socket) => socket.on('close', () => resolve()));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100)); // the websocket is open

    const t0 = Date.now();
    await drainHttpServer(server, { noticeMs: 100, deadlineMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(1_000); // not the 10s deadline
    await clientClosed; // the browser sees the close and reconnects elsewhere
  });
});
