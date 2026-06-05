import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionLogsService } from './transaction-logs.service';
import { TransactionLogsController } from './transaction-logs.controller';

// Global so the ingest interceptor (transactions module) and the Whish payments
// service can inject the log writer without import cycles — mirrors AuditModule.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [TransactionLogsController],
  providers: [TransactionLogsService],
  exports: [TransactionLogsService],
})
export class TransactionLogsModule {}
