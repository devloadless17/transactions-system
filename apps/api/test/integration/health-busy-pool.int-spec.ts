/**
 * The health check on a real Prisma pool with every connection busy — a burst.
 * Its SELECT 1 queues behind the work like any query; before this fix it waited
 * as long as the pool stayed full (4.7s measured), past Caddy's 3s health
 * timeout, so Caddy took the only API out of rotation mid-burst and a release
 * could take its busy new version for a crashed one. Busy is not down.
 */
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@app/db';
import type { PrismaService } from '../../src/database/prisma.service';
import { DB_ANSWER_WAIT_MS, HealthController } from '../../src/modules/health/health.controller';

const POOL = 2;
const HOLD_SECONDS = 5;
// Caddy's health_timeout (Caddyfile) and the release script's wget -T.
const CHECKER_TIMEOUT_MS = 3_000;

let prisma: PrismaClient;

beforeAll(async () => {
  // The app's database and role, with a pool of two so two slow transactions
  // fill it. (The health check only needs the pool: Prisma's, same as the app.)
  const url = process.env.DATABASE_URL!;
  prisma = new PrismaClient({
    datasourceUrl: `${url}${url.includes('?') ? '&' : '?'}connection_limit=${POOL}`,
  });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

const caddyCheck = {
  headers: { 'x-health-check': 'caddy' },
  socket: { remoteAddress: '172.18.0.5' },
};

async function check(hc: HealthController) {
  let status = 200;
  const res = { status: (code: number) => (status = code) } as unknown as Response;
  const t0 = performance.now();
  const body = (await hc.health(caddyCheck as unknown as Request, res)) as { db: string };
  return { status, db: body.db, ms: performance.now() - t0 };
}

/**
 * Fill every connection for HOLD_SECONDS. `released` settles when they are
 * free again (wrapped: an async function returning a promise would wait for it).
 */
async function fillPool(): Promise<{ released: Promise<unknown> }> {
  const held = Promise.all(
    Array.from({ length: POOL }, () =>
      prisma.$transaction((tx) => tx.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_SECONDS})::text`), {
        timeout: (HOLD_SECONDS + 5) * 1000,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 300)); // both have their connection
  return { released: held };
}

describe('health check with every pool connection busy', () => {
  it('answers 200 "busy" well inside the checkers\' timeout, then "ok" once the pool frees', async () => {
    const hc = new HealthController(prisma as unknown as PrismaService);
    expect(await check(hc)).toMatchObject({ status: 200, db: 'ok' });

    const { released } = await fillPool();
    // The problem itself: an ordinary query waits as long as the pool is full.
    const t0 = performance.now();
    const queued = prisma.$queryRawUnsafe('SELECT 1').then(() => performance.now() - t0);

    for (let i = 0; i < 2; i++) {
      const c = await check(hc);
      expect(c).toMatchObject({ status: 200, db: 'busy' });
      expect(c.ms).toBeGreaterThanOrEqual(DB_ANSWER_WAIT_MS - 50);
      expect(c.ms).toBeLessThan(CHECKER_TIMEOUT_MS - 500);
    }

    await released;
    expect(await queued).toBeGreaterThan(CHECKER_TIMEOUT_MS);
    expect(await check(hc)).toMatchObject({ status: 200, db: 'ok' });
  });

  it('503 if the database has never answered it (a new release must reach its database first)', async () => {
    const { released } = await fillPool();
    const fresh = new HealthController(prisma as unknown as PrismaService);
    const c = await check(fresh);
    expect(c).toMatchObject({ status: 503, db: 'down' });
    expect(c.ms).toBeLessThan(CHECKER_TIMEOUT_MS - 500);
    await released;
    expect(await check(fresh)).toMatchObject({ status: 200, db: 'ok' });
  });
});
