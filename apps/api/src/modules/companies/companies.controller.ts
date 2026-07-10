import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createCompanySchema,
  listCompaniesQuerySchema,
  updateCompanySchema,
  UserRole,
  type CreateCompanyInput,
  type ListCompaniesQuery,
  type UpdateCompanyInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { Audited } from '../audit/audit.decorator';
import { CompaniesService } from './companies.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  @Audited({
    action: 'company.created',
    entityType: 'company',
    idFrom: 'result.company.id',
    companyIdFrom: 'result.company.id',
  })
  async create(@Body(new ZodPipe(createCompanySchema)) body: CreateCompanyInput) {
    return this.companies.create(body);
  }

  // Back-office staff may view the list of companies (who's on the platform),
  // but not a company's detail/analytics — so this read is widened to BACKOFFICE
  // while every other route on this controller stays SUPER_ADMIN/ADMIN_OPERATOR.
  //
  // Wallet balances are narrower still: ONLY a SUPER_ADMIN sees how much money a
  // tenant holds. Enforced here (the service never queries wallets otherwise),
  // not in the UI — hiding a column would still ship the numbers over the wire.
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get()
  async list(
    @Query(new ZodPipe(listCompaniesQuerySchema)) query: ListCompaniesQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.companies.list(query, { includeBalances: user.role === UserRole.SUPER_ADMIN });
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.getById(id);
  }

  @Patch(':id')
  @Audited({
    action: 'company.updated',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCompanySchema)) body: UpdateCompanyInput,
  ) {
    return this.companies.update(id, body);
  }

  @Post(':id/disable')
  @Audited({
    action: 'company.disabled',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async disable(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.disable(id);
  }

  @Post(':id/activate')
  @Audited({
    action: 'company.activated',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async activate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.activate(id);
  }
}
