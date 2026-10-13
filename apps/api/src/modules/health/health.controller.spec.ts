import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { PrismaService } from '../../database/prisma.service';
import { shutdownState } from '../../common/http/graceful-drain';
import { HealthController } from './health.controller';

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
});
