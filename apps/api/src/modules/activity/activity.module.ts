import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
