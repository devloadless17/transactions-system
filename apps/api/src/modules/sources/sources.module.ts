import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SourcesAdminController } from './sources.controller';
import { SourcesService } from './sources.service';
import { CompanySourcesController } from './company-sources.controller';
import { CompanySourcesService } from './company-sources.service';

@Module({
  imports: [AuthModule],
  controllers: [SourcesAdminController, CompanySourcesController],
  providers: [SourcesService, CompanySourcesService],
  exports: [SourcesService, CompanySourcesService],
})
export class SourcesModule {}
