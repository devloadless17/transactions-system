import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { IngestController } from './ingest.controller';
import { TransactionsReadController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [
    AuthModule,
    ApiKeysModule,
    CommissionsModule,
    LedgerModule,
    WalletsModule,
    AnalyticsModule,
  ],
  controllers: [IngestController, TransactionsReadController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
