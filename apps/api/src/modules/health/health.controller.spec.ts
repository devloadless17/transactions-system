import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Prisma } from '@app/db';
import type { PrismaService } from '../../database/prisma.service';
import { shutdownState } from '../../common/http/graceful-drain';
import { DB_ANSWER_WAIT_MS, DB_BUSY_LIMIT_MS, HealthController } from './health.controller';

/**
 * Caddy routes API traffic by this endpoint (active health checks): 503 takes
 * the instance out of rotation and Caddy HOLDS new requests for the next one.
 * A blue/green release also asks it (from inside the container) whether Caddy
 * has seen it healthy yet, before draining the previous version.
 */
describe('HealthController', () => {
  afterEach(() => {
    shutdownState.draining = false;
  });

  const CADDY_PEER = '172.18.0.5';
  const request = (peer: string, headers: Record<string, string> = {}) =>
    ({ headers, socket: { remoteAddress: peer } }) as unknown as Request;
  const fromCaddyCheck = () => request(CADDY_PEER, { 'x-health-check': 'caddy' });
  const fromInside = () => request('127.0.0.1');
  const proxyCheckedMsAgo = (body: object) =>
    (body as { proxyCheckedMsAgo?: number | null }).proxyCheckedMsAgo;

  const setup = (dbUp: boolean) => {
    const prisma = {
      $queryRawUnsafe: vi.fn(() =>
        dbUp ? Promise.resolve([]) : Promise.reject(new Error('down')),
      ),
    };
    const res = { status: vi.fn() };
    return {
      controller: new HealthController(prisma as unknown as PrismaService),
      prisma,
      res: res as unknown as Response,
      status: res.status,
    };
  };

  it('200 ok while serving', async () => {
    const { controller, res, status } = setup(true);
    await expect(controller.health(request(CADDY_PEER), res)).resolves.toMatchObject({
      status: 'ok',
      db: 'ok',
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('503 degraded when the database is unreachable', async () => {
    const { controller, res, status } = setup(false);
    await expect(controller.health(request(CADDY_PEER), res)).resolves.toMatchObject({
      status: 'degraded',
    });
    expect(status).toHaveBeenCalledWith(503);
  });

  it('503 draining once a shutdown starts — without touching the database', async () => {
    const { controller, prisma, res, status } = setup(true);
    shutdownState.draining = true;
    await expect(controller.health(request(CADDY_PEER), res)).resolves.toMatchObject({
      status: 'draining',
    });
    expect(status).toHaveBeenCalledWith(503);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  describe('has Caddy seen this instance healthy? (asked by the release script)', () => {
    it('null until Caddy health-checks it', async () => {
      const { controller, res } = setup(true);
      await expect(controller.health(fromInside(), res)).resolves.toMatchObject({
        proxyCheckedMsAgo: null,
      });
    });

    it('a passing Caddy check is remembered, and reported to a caller inside the container', async () => {
      const { controller, res } = setup(true);
      await controller.health(fromCaddyCheck(), res);
      const ago = proxyCheckedMsAgo(await controller.health(fromInside(), res));
      expect(ago).toEqual(expect.any(Number));
      expect(ago).toBeLessThan(1_000);
    });

    it('only Caddy checks count: another caller through the proxy changes nothing', async () => {
      const { controller, res } = setup(true);
      await controller.health(request(CADDY_PEER), res); // e.g. an uptime monitor
      await expect(controller.health(fromInside(), res)).resolves.toMatchObject({
        proxyCheckedMsAgo: null,
      });
    });

    it('a check answered 503 is not a pass (database down, or draining)', async () => {
      const down = setup(false);
      await down.controller.health(fromCaddyCheck(), down.res);
      expect(proxyCheckedMsAgo(await down.controller.health(fromInside(), down.res))).toBeNull();

      const draining = setup(true);
      shutdownState.draining = true;
      await draining.controller.health(fromCaddyCheck(), draining.res);
      shutdownState.draining = false;
      await expect(draining.controller.health(fromInside(), draining.res)).resolves.toMatchObject({
        proxyCheckedMsAgo: null,
      });
    });

    it('is never shown through the proxy (every proxied peer is Caddy, not loopback)', async () => {
      const { controller, res } = setup(true);
      await controller.health(fromCaddyCheck(), res);
      const body = await controller.health(fromCaddyCheck(), res);
      expect(body).not.toHaveProperty('proxyCheckedMsAgo');
    });
  });

  /**
   * The check queues for a pool connection like any query. In a burst every
   * connection is busy and it waits behind the work (measured: 4.7s with the
   * pool held, past Caddy's 3s timeout) — that must not take the only API out
   * of rotation, nor make a release think its new version crashed.
   */
  describe('a busy pool is not a down database', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Every SELECT 1 waits until the test answers it.
    const setupQueued = () => {
      const checks: Array<{ answer: () => void; fail: (err: unknown) => void }> = [];
      const prisma = {
        $queryRawUnsafe: vi.fn(
          () =>
            new Promise((answer, fail) => {
              checks.push({ answer: () => answer([]), fail });
            }),
        ),
      };
      const res = { status: vi.fn() };
      return {
        controller: new HealthController(prisma as unknown as PrismaService),
        prisma,
        checks,
        res: res as unknown as Response,
        status: res.status,
      };
    };
    // One health check the database answers at once.
    const answered = async (s: ReturnType<typeof setupQueued>) => {
      const body = s.controller.health(request(CADDY_PEER), s.res);
      await vi.advanceTimersByTimeAsync(0);
      s.checks.at(-1)!.answer();
      return body;
    };
    // One health check whose SELECT 1 is still queued when the wait runs out.
    const unanswered = async (s: ReturnType<typeof setupQueued>, req = request(CADDY_PEER)) => {
      const body = s.controller.health(req, s.res);
      await vi.advanceTimersByTimeAsync(DB_ANSWER_WAIT_MS);
      return body;
    };

    it('answers 200 "busy" within the wait when the database answered moments ago', async () => {
      const s = setupQueued();
      await expect(answered(s)).resolves.toMatchObject({ status: 'ok', db: 'ok' });
      await expect(unanswered(s)).resolves.toMatchObject({ status: 'ok', db: 'busy' });
      expect(s.status).not.toHaveBeenCalled();
    });

    it("a busy answer to Caddy's check is a pass (the release script sees it)", async () => {
      const s = setupQueued();
      await answered(s);
      await vi.advanceTimersByTimeAsync(5_000);
      await unanswered(s, fromCaddyCheck());
      const body = s.controller.health(fromInside(), s.res);
      await vi.advanceTimersByTimeAsync(DB_ANSWER_WAIT_MS);
      expect(proxyCheckedMsAgo(await body)).toBe(DB_ANSWER_WAIT_MS);
    });

    it('503 while it waits if the database never answered (a new release must reach it first)', async () => {
      const s = setupQueued();
      await expect(unanswered(s)).resolves.toMatchObject({ status: 'degraded', db: 'down' });
      expect(s.status).toHaveBeenCalledWith(503);
    });

    it('503 once the database has not answered for DB_BUSY_LIMIT_MS', async () => {
      const s = setupQueued();
      await answered(s);
      await expect(unanswered(s)).resolves.toMatchObject({ db: 'busy' });
      await vi.advanceTimersByTimeAsync(DB_BUSY_LIMIT_MS - 2 * DB_ANSWER_WAIT_MS - 1);
      await expect(unanswered(s)).resolves.toMatchObject({ db: 'busy' });
      expect(s.status).not.toHaveBeenCalled();
      await expect(unanswered(s)).resolves.toMatchObject({ status: 'degraded', db: 'down' });
      expect(s.status).toHaveBeenCalledWith(503);
    });

    it('a late answer counts: once the queued check gets through, it is ok again', async () => {
      const s = setupQueued();
      await answered(s);
      await unanswered(s);
      s.checks.at(-1)!.answer();
      await vi.advanceTimersByTimeAsync(0);
      await expect(answered(s)).resolves.toMatchObject({ db: 'ok' });
    });

    it('one check in flight at a time: health checks never pile up in the pool queue', async () => {
      const s = setupQueued();
      await answered(s);
      expect(s.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      await Promise.all([unanswered(s), unanswered(s), unanswered(s)]);
      expect(s.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      s.checks.at(-1)!.answer();
      await vi.advanceTimersByTimeAsync(0);
      await answered(s);
      expect(s.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    });

    it("Prisma's pool timeout (P2024) is busy, not down", async () => {
      const s = setupQueued();
      await answered(s);
      const body = s.controller.health(request(CADDY_PEER), s.res);
      await vi.advanceTimersByTimeAsync(0);
      s.checks.at(-1)!.fail(
        new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', {
          code: 'P2024',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );
      await expect(body).resolves.toMatchObject({ status: 'ok', db: 'busy' });
      expect(s.status).not.toHaveBeenCalled();
    });

    it('a database that fails the check is down at once, however recently it answered', async () => {
      const s = setupQueued();
      await answered(s);
      const body = s.controller.health(request(CADDY_PEER), s.res);
      await vi.advanceTimersByTimeAsync(0);
      s.checks.at(-1)!.fail(new Error('connection refused'));
      await expect(body).resolves.toMatchObject({ status: 'degraded', db: 'down' });
      expect(s.status).toHaveBeenCalledWith(503);
    });
  });
});
