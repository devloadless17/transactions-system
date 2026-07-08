import { Module } from '@nestjs/common';
import { TelegramClient } from './telegram.client';

// Provides the best-effort Telegram alert client. Imported by NotificationsModule
// so the money-request notifications can also fan out to a Telegram group.
@Module({
  providers: [TelegramClient],
  exports: [TelegramClient],
})
export class TelegramModule {}
