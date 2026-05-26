import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { SourceApiKeysController } from './source-api-keys.controller';
import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';
import { ApiKeyRateLimitGuard } from './guards/api-key-rate-limit.guard';

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController, SourceApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthGuard, ApiKeyRateLimitGuard],
  exports: [ApiKeysService, ApiKeyAuthGuard, ApiKeyRateLimitGuard],
})
export class ApiKeysModule {}
