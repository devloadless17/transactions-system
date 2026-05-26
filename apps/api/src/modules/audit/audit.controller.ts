import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { listAuditLogsQuerySchema, UserRole, type ListAuditLogsQuery } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditService } from './audit.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Query(new ZodPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery) {
    return this.audit.list(query);
  }
}
