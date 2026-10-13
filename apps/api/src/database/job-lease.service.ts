/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * The lease could not be taken (held elsewhere past the wait, or the database
 * could not be reached). The guarded work did NOT start.
 */
export class LeaseUnavailableError extends Error {
  constructor(
    readonly lease: string,
    cause?: unknown,
  ) {
    super(`lease "${lease}" is held by another instance`, { cause });
    this.name = 'LeaseUnavailableError';
  }
}

/** A lease held by this instance while its work runs. */
export interface HeldLease {
  /**
   * False once a background renewal failed: the lease may have run out and
   * been taken elsewhere, so stop between items.
   */
  readonly held: boolean;
  /**
   * Renew with the database now, and say whether the lease is still ours. Call
   * it right before a step that must never run twice (claiming a withdrawal).
   * False means stop: the lease is lost.
   */
  confirm(): Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cross-instance leases (the `job_leases` table), for background work that
 * must never run in two places at once. A blue/green deploy runs the old and
 * the new API side by side for a few seconds, so an in-process "running" flag
 * no longer guarantees one runner: a lease does.
 *
 * - A lease is taken only if it is free, has run out, or is already ours, in one
 *   atomic statement. Expiry is judged by the DATABASE clock, the one clock
 *   every instance shares.
 * - While the work runs it is renewed every third of its TTL. A renewal that
 *   fails marks it lost (`held` = false), and `confirm()` re-checks on demand.
 * - It is released when the work ends. A crashed holder's lease runs out on its
 *   own after its TTL.
 * - Fail-closed: if the database can't be reached, the lease is not taken and
 *   the work does not start.
 */
@Injectable()
export class JobLeaseService {
  private readonly logger = new Logger(JobLeaseService.name);

  /**
   * This process as a lease holder: its colour (API_INSTANCE: blue / green) or
   * host, its pid, and a random tag, unique per boot. Visible in job_leases.
   */
  readonly holder = `${process.env.API_INSTANCE || hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

  constructor(private readonly prisma: PrismaService) {}

  /** Take `name` if it is free, has run out, or is ours. True = held for `ttlMs` from now. */
  async tryAcquire(name: string, ttlMs: number): Promise<boolean> {
    // One statement: two instances racing for the same row serialise on it, and
    // the loser re-reads the winner's row and finds it held (READ COMMITTED).
    const rows = await this.prisma.runAsAdmin(
      (tx) => tx.$queryRaw<Array<{ holder: string }>>`
        INSERT INTO job_leases (name, holder, acquired_at, renewed_at, expires_at)
        VALUES (${name}, ${this.holder}, now(), now(), now() + ${ttlMs}::integer * interval '1 millisecond')
        ON CONFLICT (name) DO UPDATE SET
          holder      = EXCLUDED.holder,
          acquired_at = CASE WHEN job_leases.holder = EXCLUDED.holder
                             THEN job_leases.acquired_at ELSE now() END,
          renewed_at  = now(),
          expires_at  = EXCLUDED.expires_at
        WHERE job_leases.holder = EXCLUDED.holder OR job_leases.expires_at <= now()
        RETURNING holder`,
    );
    return rows.length === 1;
  }

  /** Extend a lease we hold. False if it is no longer ours (it ran out, or was taken). */
  async renew(name: string, ttlMs: number): Promise<boolean> {
    const rows = await this.prisma.runAsAdmin(
      (tx) => tx.$queryRaw<Array<{ holder: string }>>`
        UPDATE job_leases
           SET renewed_at = now(), expires_at = now() + ${ttlMs}::integer * interval '1 millisecond'
         WHERE name = ${name} AND holder = ${this.holder} AND expires_at > now()
        RETURNING holder`,
    );
    return rows.length === 1;
  }

  /** Give a lease back at once (only if it is still ours). */
  async release(name: string): Promise<void> {
    await this.prisma.runAsAdmin(
      (tx) => tx.$executeRaw`
        UPDATE job_leases SET expires_at = now()
         WHERE name = ${name} AND holder = ${this.holder} AND expires_at > now()`,
    );
  }

  /**
   * Run `fn` only if `name` is free right now; otherwise skip (another instance
   * is doing this work). For background runs: the other instance's run covers it.
   */
  async runExclusive<T>(
    name: string,
    ttlMs: number,
    fn: (lease: HeldLease) => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (!(await this.tryAcquire(name, ttlMs))) return { ran: false };
    return { ran: true, value: await this.hold(name, ttlMs, fn) };
  }

  /**
   * Wait up to `waitMs` for `name`, then run `fn` holding it: a mutex across
   * instances. Throws LeaseUnavailableError, before `fn` starts, if the lease
   * stays taken or the database can't be reached.
   */
  async withLease<T>(
    name: string,
    opts: { ttlMs: number; waitMs: number; pollMs?: number },
    fn: (lease: HeldLease) => Promise<T>,
  ): Promise<T> {
    const deadline = performance.now() + opts.waitMs;
    for (;;) {
      let acquired: boolean;
      try {
        acquired = await this.tryAcquire(name, opts.ttlMs);
      } catch (err) {
        throw new LeaseUnavailableError(name, err);
      }
      if (acquired) break;
      if (performance.now() >= deadline) throw new LeaseUnavailableError(name);
      await sleep(opts.pollMs ?? 250);
    }
    return this.hold(name, opts.ttlMs, fn);
  }

  /** Keep a just-acquired lease renewed while `fn` runs, then release it. */
  private async hold<T>(
    name: string,
    ttlMs: number,
    fn: (lease: HeldLease) => Promise<T>,
  ): Promise<T> {
    let held = true;
    const renewNow = async (): Promise<boolean> => {
      if (!held) return false; // once lost, never "found" again mid-run
      try {
        held = await this.renew(name, ttlMs);
      } catch (err) {
        held = false; // can't prove it's ours: treat as lost (fail-closed)
        this.logger.warn(`Lease ${name}: renewal failed — ${(err as Error).message}`);
      }
      if (!held) this.logger.warn(`Lease ${name} lost by ${this.holder}; stopping its work`);
      return held;
    };
    const heartbeat = setInterval(() => void renewNow(), Math.max(1_000, Math.floor(ttlMs / 3)));
    heartbeat.unref?.();
    try {
      return await fn({
        get held() {
          return held;
        },
        confirm: renewNow,
      });
    } finally {
      clearInterval(heartbeat);
      // Only ever releases our own (the UPDATE matches holder), so this is safe
      // even if the lease was lost meanwhile.
      await this.release(name).catch((err: Error) =>
        this.logger.warn(`Lease ${name}: release failed (it runs out on its own) — ${err.message}`),
      );
    }
  }
}
