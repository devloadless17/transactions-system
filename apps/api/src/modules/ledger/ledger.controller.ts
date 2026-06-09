import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { listLedgerEntriesQuerySchema, UserRole, type ListLedgerEntriesQuery } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { LedgerService } from './ledger.service';

@UseGuards(CompanyAccessGuard, RolesGuard)
@Controller()
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/ledger')
  async companyList(
    @Query(new ZodPipe(listLedgerEntriesQuerySchema)) query: ListLedgerEntriesQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.ledger.listByCompany(user.companyId, query);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/companies/:companyId/ledger')
  async adminList(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query(new ZodPipe(listLedgerEntriesQuerySchema)) query: ListLedgerEntriesQuery,
  ) {
    return this.ledger.listByCompany(companyId, query);
  }
}
