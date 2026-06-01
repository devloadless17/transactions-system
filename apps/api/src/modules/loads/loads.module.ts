import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { LoadsService } from './loads.service';
import { LoadsController } from './loads.controller';

@Module({
  imports: [AuthModule, LedgerModule, WalletsModule, AnalyticsModule, CommissionsModule],
  controllers: [LoadsController],
  providers: [LoadsService],
  exports: [LoadsService],
})
export class LoadsModule {}
