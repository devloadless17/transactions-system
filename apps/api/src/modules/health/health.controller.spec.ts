import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { PrismaService } from '../../database/prisma.service';
import { shutdownState } from '../../common/http/graceful-drain';
import { HealthController } from './health.controller';

/**
 * Caddy routes API traffic by this endpoint (active health checks): 503 takes
 * the instance out of rotation and Caddy HOLDS new requests for the next one.
 */
describe('HealthController', () => {
  afterEach(() => {
    shutdownState.draining = false;
  });

  const setup = (dbUp: boolean) => {
    const prisma = {
      $queryRawUnsafe: vi.fn(() =>
        dbUp ? Promise.resolve([]) : Promise.reject(new Error('down')),
      ),
    };
    const res = { status: vi.fn() };
    return { controller: new HealthController(prisma as unknown as PrismaService), prisma, res };
  };

  it('200 ok while serving', async () => {
    const { controller, res } = setup(true);
    await expect(controller.health(res as unknown as Response)).resolves.toMatchObject({
      status: 'ok',
      db: 'ok',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('503 degraded when the database is unreachable', async () => {
    const { controller, res } = setup(false);
    await expect(controller.health(res as unknown as Response)).resolves.toMatchObject({
      status: 'degraded',
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('503 draining once a shutdown starts — without touching the database', async () => {
    const { controller, prisma, res } = setup(true);
    shutdownState.draining = true;
    await expect(controller.health(res as unknown as Response)).resolves.toMatchObject({
      status: 'draining',
    });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
