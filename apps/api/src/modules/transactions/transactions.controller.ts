import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  listTransactionsQuerySchema,
  reverseTransactionSchema,
  UserRole,
  type ListTransactionsQuery,
  type ReverseTransactionInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { TransactionsService } from './transactions.service';
import { ForbiddenError } from '../../common/errors/domain.error';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class TransactionsReadController {
  constructor(private readonly transactions: TransactionsService) {}

  // ---------- Admin ----------
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions')
  async adminList(@Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery) {
    return this.transactions.list({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/export.csv')
  @SkipResponseEnvelope()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async adminExport(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${Date.now()}.csv"`);
    return this.transactions.exportCsv({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.transactions.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/transactions/:id/detail')
  async adminGetDetail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.transactions.getDetail(id);
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
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async companyExport(
    @Query(new ZodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery,
    @CurrentUser() user: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${Date.now()}.csv"`);
    return this.transactions.exportCsv({ companyId: user.companyId, query });
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
