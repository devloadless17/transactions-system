/**
 * Job leases against real Postgres (RLS on, the app's own role). A blue/green
 * deploy runs two API versions at once; these prove that only one of them can
 * hold a lease — even when they race for it — that a dead holder's lease runs
 * out by the DATABASE clock, and that a holder which lost its lease finds out.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobLeaseService, LeaseUnavailableError } from '../../src/database/job-lease.service';
import { buildHarness, createCompany, type Harness } from './harness';

let h: Harness;
const instance = () => new JobLeaseService(h.prisma);
const leaseName = () => `it-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the DATABASE says the lease ran out more than 2s ago. Its clock
 * decides expiry, not ours, and a wall clock can step back (WSL2 jumps ~1.5s
 * every ~30s), so a fixed sleep is not proof — and a 2s margin keeps it
 * expired through such a step.
 */
async function untilExpired(name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [row] = await h.prisma.runAsAdmin(
      (tx) => tx.$queryRaw<Array<{ expired: boolean }>>`
        SELECT now() - expires_at > interval '2 seconds' AS expired
          FROM job_leases WHERE name = ${name}`,
    );
    if (row?.expired) return;
    await sleep(100);
  }
  throw new Error(`lease ${name} never ran out`);
}

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('job leases', () => {
  it('one holder at a time: renewing keeps it, releasing hands it over', async () => {
    const [blue, green] = [instance(), instance()];
    const name = leaseName();

    expect(await blue.tryAcquire(name, 60_000)).toBe(true);
    expect(await green.tryAcquire(name, 60_000)).toBe(false);
    expect(await blue.tryAcquire(name, 60_000)).toBe(true); // ours already: re-taking is fine
    expect(await blue.renew(name, 60_000)).toBe(true);
    expect(await green.renew(name, 60_000)).toBe(false); // never renews what it doesn't hold
    expect(await green.tryAcquire(name, 60_000)).toBe(false);

    await green.release(name); // not green's: changes nothing
    expect(await green.tryAcquire(name, 60_000)).toBe(false);

    await blue.release(name);
    expect(await green.tryAcquire(name, 60_000)).toBe(true);
    expect(await blue.tryAcquire(name, 60_000)).toBe(false);
  });

  it('a dead holder loses the lease when its TTL runs out, and finds out if it wakes', async () => {
    const [crashed, next] = [instance(), instance()];
    const name = leaseName();

    expect(await crashed.tryAcquire(name, 300)).toBe(true);
    expect(await next.tryAcquire(name, 60_000)).toBe(false);
    await untilExpired(name);
    expect(await next.tryAcquire(name, 60_000)).toBe(true);
    // The old holder can't quietly carry on: its renewal says it lost the lease.
    expect(await crashed.renew(name, 60_000)).toBe(false);
  });

  it('an expired lease is not renewable even if nobody took it (re-acquire instead)', async () => {
    const holder = instance();
    const name = leaseName();
    expect(await holder.tryAcquire(name, 200)).toBe(true);
    await untilExpired(name);
    expect(await holder.renew(name, 60_000)).toBe(false);
    expect(await holder.tryAcquire(name, 60_000)).toBe(true);
  });

  it('many instances racing for a free lease: exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      const racers = Array.from({ length: 12 }, () => instance());
      const name = leaseName();
      const won = await Promise.all(racers.map((r) => r.tryAcquire(name, 60_000)));
      expect(won.filter(Boolean)).toHaveLength(1);
    }
  });

  it('many instances racing for an EXPIRED lease: exactly one wins', async () => {
    const name = leaseName();
    expect(await instance().tryAcquire(name, 100)).toBe(true);
    await untilExpired(name);
    const racers = Array.from({ length: 12 }, () => instance());
    const won = await Promise.all(racers.map((r) => r.tryAcquire(name, 60_000)));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('runExclusive skips while another instance runs; withLease waits for its release', async () => {
    const [blue, green] = [instance(), instance()];
    const name = leaseName();
    const order: string[] = [];

    const blueRun = blue.runExclusive(name, 60_000, async () => {
      order.push('blue starts');
      await sleep(400);
      order.push('blue ends');
    });
    await sleep(100); // blue holds it now
    expect(await green.runExclusive(name, 60_000, async () => order.push('green ran'))).toEqual({
      ran: false,
    });

    const greenWaits = green.withLease(
      name,
      { ttlMs: 60_000, waitMs: 5_000, pollMs: 50 },
      async () => {
        order.push('green runs');
      },
    );
    await Promise.all([blueRun, greenWaits]);
    expect(order).toEqual(['blue starts', 'blue ends', 'green runs']);
  });

  it('withLease gives up after its wait, without running', async () => {
    const [holder, waiter] = [instance(), instance()];
    const name = leaseName();
    expect(await holder.tryAcquire(name, 60_000)).toBe(true);
    let ran = false;
    await expect(
      waiter.withLease(name, { ttlMs: 60_000, waitMs: 300, pollMs: 50 }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(ran).toBe(false);
  });

  it('a tenant can neither see nor take a lease (platform-level, RLS)', async () => {
    const holder = instance();
    const name = leaseName();
    expect(await holder.tryAcquire(name, 60_000)).toBe(true);
    const { companyId } = await createCompany(h);

    const seen = await h.prisma.runAsTenant(
      companyId,
      (tx) =>
        tx.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*)::bigint AS n FROM job_leases WHERE name = ${name}`,
    );
    expect(Number(seen[0]!.n)).toBe(0);
    await expect(
      h.prisma.runAsTenant(
        companyId,
        (tx) =>
          tx.$executeRaw`INSERT INTO job_leases (name, holder, expires_at) VALUES (${leaseName()}, 'tenant', now() + interval '1 hour')`,
      ),
    ).rejects.toThrow();
  });
});
