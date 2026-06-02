import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Global so any service can inject `RealtimeService` to announce changes
 * without wiring imports per module (mirrors PrismaModule / CacheModule).
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
