import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@app/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import {
  ReconciliationService,
  type ReceivableBalance,
  type ReconciliationReport,
} from './reconciliation.service';

/**
 * Admin view of the ledger↔wallet reconciliation. `GET` returns the last run
 * (computing one on first access); `POST run` forces a fresh run now and audits
 * the operator who triggered it.
 */
// CsrfGuard guards the mutating POST /run (it no-ops on safe GETs), matching
// every other cookie-authed mutating controller.
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  async latest(): Promise<ReconciliationReport> {
    return this.reconciliation.getLastReport() ?? this.reconciliation.reconcileAll();
  }

  @Post('run')
  async run(@CurrentUser() user: AuthPrincipal): Promise<ReconciliationReport> {
    return this.reconciliation.reconcileAll({ actorId: user.userId });
  }

  /** Outstanding company debts created by under-funded reversals (focused query). */
  @Get('receivables')
  async receivables(): Promise<ReceivableBalance[]> {
    return this.reconciliation.listReceivables();
  }
}
