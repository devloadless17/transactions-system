import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@app/db';
import { CompanyQueue } from './company-queue';

// Serializable transactions are designed to abort-and-retry: under contention
// Postgres raises serialization_failure (40001) / deadlock_detected (40P01),
// which Prisma surfaces as P2034. An aborted transaction commits nothing, so a
// fresh re-run of the same closure is safe.
const SERIALIZABLE_MAX_ATTEMPTS = 5;
const SERIALIZABLE_BASE_BACKOFF_MS = 10;

function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
  // A unique-violation (P2002 / 23505) inside a SERIALIZABLE money mutation is a
  // transient lost race, not a logic error: two concurrent writers raced to
  // lazily-provision the same (company, currency) wallet, or to insert the same
  // (source, externalId) / idempotency key. Postgres raises 23505 (not 40001) for
  // a unique conflict, so without this it surfaces as a spurious 409. Re-running
  // the whole closure converges correctly: the wallet now exists (read+update),
  // and ingest's idempotency check finds the committed row and replays it. Only
  // runSerializable* uses this retry, so non-serializable paths (e.g. a duplicate
  // company slug) still fail fast with their 409.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return true;
  const code = (err as { code?: string } | null)?.code;
  if (code === '40001' || code === '40P01') return true;
  const message = err instanceof Error ? err.message : '';
  return /could not serialize access|deadlock detected|40001|40P01/i.test(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  // Same-company money transactions take turns instead of racing for the
  // company's wallet row — see CompanyQueue.
  private readonly companyQueue = new CompanyQueue();

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [
              { level: 'warn', emit: 'event' },
              { level: 'error', emit: 'event' },
            ]
          : [{ level: 'error', emit: 'event' }],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected');
    await this.assertRlsEnforced();
  }

  /**
   * Defense-in-depth: the entire tenant-isolation model assumes the runtime DB
   * role is SUBJECT to row-level security. Postgres skips RLS entirely for
   * superusers and roles with the BYPASSRLS attribute — so a deploy mistakenly
   * connecting as such a role would turn every RLS policy into a silent no-op,
   * letting tenants read each other's rows with no error anywhere. The boot
   * guard in env.schema validates the connection STRING (no dev password); this
   * asserts the actual ROLE the database hands us can't bypass RLS. Fail hard in
   * production; warn loudly elsewhere (dev/test may legitimately use a superuser).
   */
  private async assertRlsEnforced(): Promise<void> {
    const isProd = process.env.NODE_ENV === 'production';
    try {
      const rows = await this.$queryRaw<
        Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      const role = rows[0];
      if (!role || role.rolsuper || role.rolbypassrls) {
        const name = role?.role ?? 'unknown';
        const msg =
          `runtime DB role "${name}" can BYPASS row-level security ` +
          `(superuser/BYPASSRLS) — RLS tenant isolation is NOT enforced`;
        if (isProd) {
          throw new Error(
            `FATAL: ${msg}. Connect the app as a non-superuser role that is subject to RLS.`,
          );
        }
        this.logger.warn(`${msg}. Allowed outside production, but never deploy this way.`);
      }
    } catch (err) {
      // A genuine misconfig must not be swallowed in production.
      if (isProd) throw err;
      this.logger.warn(`could not verify RLS-role enforcement: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside a DB transaction with the tenant GUC set, so that
   * RLS scopes every query to `companyId`. SUPER_ADMIN callers should
   * use `runAsAdmin` instead.
   */
  async runAsTenant<T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
    opts?: { timeout?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await setTenantContext(tx, companyId);
        // Cast keeps the closure free of the broader $transaction client interface.
        return fn(tx as unknown as PrismaClient);
      },
      // Same reasoning as runAsAdmin: a wide read (an all-time analytics window
      // runs ~11 aggregates in one transaction) must not abort on Prisma's 5s
      // interactive-transaction default. Reads only, so a long timeout is safe.
      opts?.timeout ? { timeout: opts.timeout, maxWait: 5_000 } : undefined,
    );
  }

  /**
   * Run `fn` inside a DB transaction with RLS bypass enabled (for
   * SUPER_ADMIN / ADMIN_OPERATOR endpoints and system jobs).
   */
  async runAsAdmin<T>(
    fn: (tx: PrismaClient) => Promise<T>,
    opts?: { timeout?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        return fn(tx as unknown as PrismaClient);
      },
      // Heavy cross-tenant reads (e.g. the reconciliation full sweep over the whole
      // ledger) pass an explicit timeout so they don't hit Prisma's 5s interactive
      // -transaction default and abort at scale. Reads, so a long timeout is safe.
      opts?.timeout ? { timeout: opts.timeout, maxWait: 5_000 } : undefined,
    );
  }

  /**
   * Run `fn` scoped to a tenant when `companyId` is set (RLS enforces the
   * scope — a forgotten where-clause can't leak another tenant's rows), or as
   * admin (RLS bypass) for genuine cross-tenant/admin reads when it is null.
   * Lets one service method serve both a company actor and an admin safely.
   */
  async runAsScoped<T>(
    companyId: string | null,
    fn: (tx: PrismaClient) => Promise<T>,
    opts?: { timeout?: number },
  ): Promise<T> {
    return companyId ? this.runAsTenant(companyId, fn, opts) : this.runAsAdmin(fn, opts);
  }

  /**
   * Serializable transaction + transient-conflict retry (Postgres 40001/40P01,
   * Prisma P2034) with jittered backoff, with NO RLS context set — `fn` must set
   * its own (or rely on bypass). Financial mutations should instead use
   * `runSerializableAsTenant`, which scopes every write to a company; this raw
   * variant exists for non-tenant serializable work.
   */
  async runSerializable<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.runSerializableRaw(fn);
  }

  /**
   * Like `runSerializable`, but scoped to a tenant: sets `app.current_company_id`
   * so RLS WITH CHECK validates that every row written in `fn` belongs to
   * `companyId` (defense-in-depth — a bug can't write into another tenant).
   * Used by the company-known write flows (ingest, withdrawal/payout/load
   * request). Caller does NOT set the RLS context — this does.
   *
   * Queued per company (CompanyQueue): one company's money transactions run one
   * at a time, in arrival order, so a burst for the same company is booked in
   * order instead of conflicting and failing. Never start one from inside
   * another's `fn` for the same company — use the `tx` you are given.
   */
  async runSerializableAsTenant<T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.companyQueue.run(companyId, () =>
      this.runSerializableRaw(async (tx) => {
        await setTenantContext(tx, companyId);
        return fn(tx);
      }),
    );
  }

  private async runSerializableRaw<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.$transaction((tx) => fn(tx as unknown as PrismaClient), {
          isolationLevel: 'Serializable',
        });
      } catch (err) {
        if (attempt < SERIALIZABLE_MAX_ATTEMPTS && isRetryableTxError(err)) {
          const base = SERIALIZABLE_BASE_BACKOFF_MS * 2 ** (attempt - 1);
          const backoff = base + Math.floor(Math.random() * base); // full-ish jitter
          this.logger.warn(
            `serializable tx conflict (attempt ${attempt}/${SERIALIZABLE_MAX_ATTEMPTS}); retrying in ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Set the tenant RLS context for the current transaction. Uses
 * `set_config(name, value, is_local=true)` — the function form of `SET LOCAL`
 * — via a PARAMETERIZED query, so the company id is a bound value that is never
 * string-interpolated into SQL. `escapeUuid` is kept as belt-and-suspenders
 * validation (a non-UUID can't even reach the DB), so the tenant boundary now
 * rests on parameter binding rather than on a regex guarding interpolation.
 */
async function setTenantContext(
  tx: { $queryRaw: PrismaClient['$queryRaw'] },
  companyId: string,
): Promise<void> {
  const safeId = escapeUuid(companyId);
  await tx.$queryRaw`SELECT set_config('app.current_company_id', ${safeId}, true)`;
}

// gen_random_uuid() returns a normal UUID; we still defensively validate the
// value is a well-formed UUID before it is bound into the tenant-context query.
function escapeUuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid UUID passed to tenant context');
  }
  return id;
}
