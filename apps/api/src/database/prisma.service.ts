import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@app/db';

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
