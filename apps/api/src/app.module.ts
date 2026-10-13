import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { AppLoggerModule } from './common/logging/logger.module';
import { PrismaModule } from './database/prisma.module';
import { CacheModule } from './modules/cache/cache.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { SourcesModule } from './modules/sources/sources.module';
import { CommissionsModule } from './modules/commissions/commissions.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { LoadsModule } from './modules/loads/loads.module';
import { ActivityModule } from './modules/activity/activity.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';
import { TransactionLogsModule } from './modules/transaction-logs/transaction-logs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { TeamModule } from './modules/team/team.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { WhishModule } from './modules/whish/whish.module';
import { CrmModule } from './modules/crm/crm.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler-storage';
import { skipThrottle } from './common/throttler/skip-throttle';
import type { Env } from './config/env.schema';

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    CacheModule,
    RealtimeModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: cfg.get('RATE_LIMIT_TTL', { infer: true }) * 1000,
            limit: cfg.get('RATE_LIMIT_MAX', { infer: true }),
          },
        ],
        // Never counted: internal health checks (Caddy routes by them — a 429
        // there reads as "API down"), and everything under THROTTLE_DISABLED,
        // the e2e suite's escape hatch, which prod/staging never set. (Skips
        // both the global and the per-route @Throttle limits.) See skipThrottle.
        skipIf: skipThrottle,
        // Shared across instances + restart-durable (the in-memory default
        // makes the login/refresh limits per-process — `limit × instances`).
        storage: new RedisThrottlerStorage(cfg.get('REDIS_URL', { infer: true })),
      }),
    }),
    HealthModule,
    AuthModule,
    AuditModule,
    TransactionLogsModule,
    CompaniesModule,
    SourcesModule,
    CommissionsModule,
    ApiKeysModule,
    LedgerModule,
    WalletsModule,
    TransactionsModule,
    WithdrawalsModule,
    PayoutsModule,
    LoadsModule,
    ActivityModule,
    NotificationsModule,
    AnalyticsModule,
    TeamModule,
    AdminUsersModule,
    WhishModule,
    CrmModule,
    ReconciliationModule,
    MaintenanceModule,
    MetricsModule,
  ],
  providers: [
    // Registered FIRST so it is the outermost interceptor: its response-wrapping
    // map() runs LAST, after Audit/Metrics/ingest-log have read the raw payload.
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
