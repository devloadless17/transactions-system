import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// Global so the money modules (withdrawals/payouts/loads) can inject
// NotificationsService without importing this module everywhere.
@Global()
@Module({
  imports: [AuthModule, ApiKeysModule, TelegramModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
