import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  listTransactionsQuerySchema,
  reverseTransactionSchema,
  UserRole,
  type ListTransactionsQuery,
  type ReverseTransactionInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { TransactionsService } from './transactions.service';
import {
  backofficeList,
  backofficeTransaction,
  backofficeTransactionDetail,
  isBackoffice,
} from '../../common/backoffice-view';
import { ForbiddenError } from '../../common/errors/domain.error';

@UseGuards(CompanyAccessGuard, RolesGuard)
@Controller()
export class TransactionsReadController {
  constructor(private readonly transactions: TransactionsService) {}

  // ---------- Admin ----------
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions')
  async adminList(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const page = await this.transactions.listForAdmin(query);
    return isBackoffice(user) ? backofficeList(page, backofficeTransaction) : page;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/export.csv')
  @SkipResponseEnvelope()
  adminExport(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<StreamableFile> {
    return this.transactions.streamCsv({ query, backoffice: isBackoffice(user) });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    const row = await this.transactions.getById(id);
    return isBackoffice(user) ? backofficeTransaction(row) : row;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/:id/detail')
  async adminGetDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const detail = await this.transactions.getDetail(id);
    return isBackoffice(user) ? backofficeTransactionDetail(detail) : detail;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @UseGuards(CsrfGuard)
  @Post('admin/transactions/:id/reverse')
  @Audited({ action: 'transaction.reversed', entityType: 'transaction', idFrom: 'params.id' })
  async reverse(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(reverseTransactionSchema)) body: ReverseTransactionInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.transactions.reverse(id, { actorId: user.userId, reason: body.reason });
  }

  // ---------- Company ----------
  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/transactions')
  async companyList(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.transactions.list({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/transactions/export.csv')
  @SkipResponseEnvelope()
  companyExport(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<StreamableFile> {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.transactions.streamCsv({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/transactions/:id')
  async companyGet(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.transactions.getById(id, user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/transactions/:id/detail')
  async companyGetDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.transactions.getDetail(id, user.companyId);
  }
}
