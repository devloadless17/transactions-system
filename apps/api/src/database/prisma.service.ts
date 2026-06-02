import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@app/db';

// Serializable transactions are designed to abort-and-retry: under contention
// Postgres raises serialization_failure (40001) / deadlock_detected (40P01),
// which Prisma surfaces as P2034. An aborted transaction commits nothing, so a
// fresh re-run of the same closure is safe.
const SERIALIZABLE_MAX_ATTEMPTS = 5;
const SERIALIZABLE_BASE_BACKOFF_MS = 10;

function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
  const code = (err as { code?: string } | null)?.code;
  if (code === '40001' || code === '40P01') return true;
  const message = err instanceof Error ? err.message : '';
  return /could not serialize access|deadlock detected|40001|40P01/i.test(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

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
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside a DB transaction with the tenant GUC set, so that
   * RLS scopes every query to `companyId`. SUPER_ADMIN callers should
   * use `runAsAdmin` instead.
   */
  async runAsTenant<T>(companyId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_company_id = '${escapeUuid(companyId)}'`);
      // Cast keeps the closure free of the broader $transaction client interface.
      return fn(tx as unknown as PrismaClient);
    });
  }

  /**
   * Run `fn` inside a DB transaction with RLS bypass enabled (for
   * SUPER_ADMIN / ADMIN_OPERATOR endpoints and system jobs).
   */
  async runAsAdmin<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      return fn(tx as unknown as PrismaClient);
    });
  }

  /**
   * Run `fn` inside a Serializable transaction, retrying on transient
   * serialization/deadlock failures (Postgres 40001/40P01, Prisma P2034) with
   * jittered exponential backoff. Every financial mutation (ingest, reverse,
   * withdrawal/payout/load lifecycle, Whish settlement) must go through this so
   * normal contention is retried transparently instead of surfacing as a 500.
   *
   * The caller is still responsible for setting the RLS context inside `fn`
   * (e.g. `SET LOCAL app.bypass_rls = 'on'`), exactly as before.
   */
  async runSerializable<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
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

// gen_random_uuid() returns a normal UUID; we still defensively check
// that the value is a valid UUID before interpolating it into the SET
// LOCAL statement (which doesn't support parameter binding).
function escapeUuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid UUID passed to tenant context');
  }
  return id;
}
