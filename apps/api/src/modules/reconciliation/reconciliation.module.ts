import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';

// PrismaService, AuditService and the Prometheus providers are all @Global, so
// only AuthModule (which supplies the JWT/Roles guards' dependencies) is
// imported here.
@Module({
  imports: [AuthModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
