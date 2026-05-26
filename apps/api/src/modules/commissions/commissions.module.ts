import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommissionResolverService } from './commission-resolver.service';
import { CommissionsRepository } from './commissions.repository';
import { CommissionsService } from './commissions.service';
import { CommissionsController } from './commissions.controller';

@Module({
  imports: [AuthModule],
  controllers: [CommissionsController],
  providers: [CommissionResolverService, CommissionsRepository, CommissionsService],
  exports: [CommissionResolverService, CommissionsRepository, CommissionsService],
})
export class CommissionsModule {}
