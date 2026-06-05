import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  listTransactionLogsQuerySchema,
  UserRole,
  type ListTransactionLogsQuery,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TransactionLogsService } from './transaction-logs.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/transaction-logs')
export class TransactionLogsController {
  constructor(private readonly logs: TransactionLogsService) {}

  @Get()
  async list(@Query(new ZodPipe(listTransactionLogsQuerySchema)) query: ListTransactionLogsQuery) {
    return this.logs.list(query);
  }
}
