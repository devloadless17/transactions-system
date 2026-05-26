import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { PlatformAnalyticsController } from './platform-analytics.controller';

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController, PlatformAnalyticsController],
  providers: [AnalyticsService, PlatformAnalyticsService],
  exports: [AnalyticsService, PlatformAnalyticsService],
})
export class AnalyticsModule {}
