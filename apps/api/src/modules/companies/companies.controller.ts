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

  @Get()
  async list(@Query(new ZodPipe(listCompaniesQuerySchema)) query: ListCompaniesQuery) {
    return this.companies.list(query);
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
}
