import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CrmModule } from '../crm/crm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminDepositsController } from './admin-deposits.controller';
import { IngestController } from './ingest.controller';
import { TransactionsReadController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { IngestLogInterceptor } from './interceptors/ingest-log.interceptor';

@Module({
  imports: [
    AuthModule,
    ApiKeysModule,
    CommissionsModule,
    LedgerModule,
    WalletsModule,
    AnalyticsModule,
    CrmModule,
    NotificationsModule,
  ],
  controllers: [IngestController, TransactionsReadController, AdminDepositsController],
  providers: [TransactionsService, IngestLogInterceptor],
  exports: [TransactionsService],
})
export class TransactionsModule {}
