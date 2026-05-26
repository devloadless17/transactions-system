import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesAdminController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [AuthModule],
  controllers: [SourcesAdminController],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}
