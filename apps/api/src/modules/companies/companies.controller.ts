import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createCompanySchema,
  listCompaniesQuerySchema,
  setNetworkFeeConfigSchema,
  updateCompanySchema,
  UserRole,
  type CreateCompanyInput,
  type ListCompaniesQuery,
  type SetNetworkFeeConfigInput,
  type UpdateCompanyInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal, AuthenticatedRequest } from '../../common/types/request.types';
import { Audited } from '../audit/audit.decorator';
import { recordAuditChanges } from '../audit/audit-changes';
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
  // tenant holds, and only when they explicitly ask (`?withBalances=true`).
  // Both conditions are required:
  //   - the role check is the AUTHORIZATION gate (the service never queries the
  //     wallets otherwise, so the figures cannot leak over the wire);
  //   - the opt-in keeps the cost off callers that only want names — notably the
  //     admin company-name filter, which fetches up to 100 companies per render.
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get()
  async list(
    @Query(new ZodPipe(listCompaniesQuerySchema)) query: ListCompaniesQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const includeBalances = query.withBalances === 'true' && user.role === UserRole.SUPER_ADMIN;
    return this.companies.list(query, { includeBalances });
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
    @CurrentUser() user: AuthPrincipal,
    @Req() req: AuthenticatedRequest,
  ) {
    // Renames and slug changes are SUPER_ADMIN-only; both checks live in the
    // service, next to the write, keyed on the actor role passed here.
    // Per-field (not per-route) because ADMIN_OPERATOR legitimately PATCHes the
    // other fields (e.g. the visibility toggle).
    return this.companies.update(id, body, {
      actorRole: user.role,
      // Hand the post-commit field diff to AuditInterceptor through the request,
      // so the `company.updated` row records WHICH fields changed and their
      // before→after values. The interceptor cannot see the previous values.
      onChanges: (changes) => recordAuditChanges(req, changes),
    });
  }

  @Get(':id/network-fee')
  async getNetworkFee(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.getNetworkFee(id);
  }

  // The network fee is pricing — it changes what a tenant is charged — so only a
  // SUPER_ADMIN may change it (this overrides the class-level roles), like the
  // other money switch, withdrawal auto-approval. ADMIN_OPERATOR can read it
  // (GET above / the company detail) but not change it. Session + CSRF only:
  // admin routes are never reachable with an API key.
  @Roles(UserRole.SUPER_ADMIN)
  @Put(':id/network-fee')
  @Audited({
    action: 'company.network_fee_updated',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async setNetworkFee(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(setNetworkFeeConfigSchema)) body: SetNetworkFeeConfigInput,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.companies.setNetworkFee(id, body, {
      onChanges: (changes) => recordAuditChanges(req, changes),
    });
  }

  @Post(':id/disable')
  @Audited({
    action: 'company.disabled',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async disable(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) {
    return this.companies.disable(id, { onChanges: (c) => recordAuditChanges(req, c) });
  }

  @Post(':id/activate')
  @Audited({
    action: 'company.activated',
    entityType: 'company',
    idFrom: 'params.id',
    companyIdFrom: 'params.id',
  })
  async activate(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) {
    return this.companies.activate(id, { onChanges: (c) => recordAuditChanges(req, c) });
  }
}
