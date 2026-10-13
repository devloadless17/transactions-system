import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { JobLeaseService } from './job-lease.service';

@Global()
@Module({
  providers: [PrismaService, JobLeaseService],
  exports: [PrismaService, JobLeaseService],
})
export class PrismaModule {}
