import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformAnalyticsController } from './platform-analytics.controller';

@Module({
  imports: [AuthModule, ApiKeysModule, LedgerModule],
  controllers: [AnalyticsController, PlatformAnalyticsController],
  providers: [AnalyticsService, PlatformAnalyticsService],
  exports: [AnalyticsService, PlatformAnalyticsService],
})
export class AnalyticsModule {}
