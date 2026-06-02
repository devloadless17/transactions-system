import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

// PrismaService is @Global, so no imports are needed.
@Module({
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
