import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobLeaseService, LeaseUnavailableError } from './job-lease.service';
import type { PrismaService } from './prisma.service';

/**
 * The lease logic around the SQL (the SQL itself runs against real Postgres in
 * test/integration/job-leases.int-spec.ts): work starts only with the lease,
 * a lost lease is noticed and never "found" again, and the lease is always
 * given back.
 */
function service() {
  const svc = new JobLeaseService({} as PrismaService);
  const tryAcquire = vi.spyOn(svc, 'tryAcquire');
  const renew = vi.spyOn(svc, 'renew').mockResolvedValue(true);
  const release = vi.spyOn(svc, 'release').mockResolvedValue();
  return { svc, tryAcquire, renew, release };
}

describe('JobLeaseService', () => {
  afterEach(() => vi.useRealTimers());

  it('names each process uniquely, by colour when it has one', () => {
    const a = new JobLeaseService({} as PrismaService);
    const b = new JobLeaseService({} as PrismaService);
    expect(a.holder).not.toEqual(b.holder);
    expect(a.holder).toContain(`:${process.pid}:`);
  });

  describe('runExclusive', () => {
    it('skips the work while another instance holds the lease', async () => {
      const { svc, tryAcquire, release } = service();
      tryAcquire.mockResolvedValue(false);
      const fn = vi.fn();
      await expect(svc.runExclusive('job', 60_000, fn)).resolves.toEqual({ ran: false });
      expect(fn).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('runs the work holding the lease, then gives it back', async () => {
      const { svc, tryAcquire, release } = service();
      tryAcquire.mockResolvedValue(true);
      const result = await svc.runExclusive('job', 60_000, async (lease) => {
        expect(lease.held).toBe(true);
        expect(release).not.toHaveBeenCalled();
        return 42;
      });
      expect(result).toEqual({ ran: true, value: 42 });
      expect(release).toHaveBeenCalledWith('job');
    });

    it('gives the lease back even when the work throws', async () => {
      const { svc, tryAcquire, release } = service();
      tryAcquire.mockResolvedValue(true);
      await expect(
        svc.runExclusive('job', 60_000, () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      expect(release).toHaveBeenCalledWith('job');
    });

    it('does not start the work when the database cannot be reached', async () => {
      const { svc, tryAcquire } = service();
      tryAcquire.mockRejectedValue(new Error('db down'));
      const fn = vi.fn();
      await expect(svc.runExclusive('job', 60_000, fn)).rejects.toThrow('db down');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('a held lease', () => {
    it('is renewed every third of its TTL while the work runs', async () => {
      vi.useFakeTimers();
      const { svc, tryAcquire, renew } = service();
      tryAcquire.mockResolvedValue(true);
      let finish = () => {};
      const run = svc.runExclusive(
        'job',
        3_000,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(3_100);
      expect(renew).toHaveBeenCalledTimes(3); // at 1s, 2s, 3s
      finish();
      await run;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renew).toHaveBeenCalledTimes(3); // and never after the work ended
    });

    it('is marked lost when a renewal fails, and confirm() then stays false', async () => {
      vi.useFakeTimers();
      const { svc, tryAcquire, renew } = service();
      tryAcquire.mockResolvedValue(true);
      renew.mockResolvedValueOnce(false); // taken elsewhere after running out
      await svc.runExclusive('job', 3_000, async (lease) => {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(lease.held).toBe(false);
        renew.mockResolvedValue(true); // a lost lease is never "found" again
        await expect(lease.confirm()).resolves.toBe(false);
      });
      expect(renew).toHaveBeenCalledTimes(1);
    });

    it('confirm() renews with the database and fails closed when it cannot', async () => {
      const { svc, tryAcquire, renew } = service();
      tryAcquire.mockResolvedValue(true);
      await svc.runExclusive('job', 60_000, async (lease) => {
        await expect(lease.confirm()).resolves.toBe(true);
        expect(renew).toHaveBeenCalledWith('job', 60_000);
        renew.mockRejectedValueOnce(new Error('db down'));
        await expect(lease.confirm()).resolves.toBe(false);
        expect(lease.held).toBe(false);
      });
    });
  });

  describe('withLease (a mutex across instances)', () => {
    it('waits for the lease, then runs', async () => {
      const { svc, tryAcquire, release } = service();
      tryAcquire.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
      const fn = vi.fn().mockResolvedValue('sent');
      await expect(
        svc.withLease('send', { ttlMs: 60_000, waitMs: 5_000, pollMs: 5 }, fn),
      ).resolves.toBe('sent');
      expect(tryAcquire).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith('send');
    });

    it('gives up after its wait, before running anything', async () => {
      const { svc, tryAcquire, release } = service();
      tryAcquire.mockResolvedValue(false);
      const fn = vi.fn();
      await expect(
        svc.withLease('send', { ttlMs: 60_000, waitMs: 50, pollMs: 5 }, fn),
      ).rejects.toBeInstanceOf(LeaseUnavailableError);
      expect(fn).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('reports an unreachable database as unavailable, before running anything', async () => {
      const { svc, tryAcquire } = service();
      const down = new Error('db down');
      tryAcquire.mockRejectedValue(down);
      const fn = vi.fn();
      const err = await svc
        .withLease('send', { ttlMs: 60_000, waitMs: 5_000 }, fn)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseUnavailableError);
      expect((err as LeaseUnavailableError).cause).toBe(down);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
