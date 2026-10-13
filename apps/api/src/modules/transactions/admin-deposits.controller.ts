import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  createManualDepositSchema,
  manualDepositPreviewSchema,
  UserRole,
  type CreateManualDepositInput,
  type ManualDepositPreviewInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { TransactionsService } from './transactions.service';

/**
 * Manual deposits: a super admin records, by hand, a deposit a source has made
 * but is not yet sending through the ingest API. Booked through the same
 * ingest() path as the API, so it is the same deposit — priced, credited and
 * sent to the company's CRM identically.
 *
 * SUPER_ADMIN only: it puts money into a company's wallet. Dashboard session
 * only (JwtAuthGuard — never an API key), CSRF-guarded.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/deposits')
export class AdminDepositsController {
  constructor(private readonly transactions: TransactionsService) {}

  /** What the deposit would book (fee, network fee, net credited) — books nothing. */
  @Post('preview')
  preview(@Body(new ZodPipe(manualDepositPreviewSchema)) body: ManualDepositPreviewInput) {
    return this.transactions.previewManualDeposit(body);
  }

  // Audited as its own action, so "which deposits did we enter by hand" is one
  // audit-log filter — attributed to the company it credited.
  @Post()
  @Audited({
    action: 'transaction.manual_deposit',
    entityType: 'transaction',
    idFrom: 'result.id',
    companyIdFrom: 'result.companyId',
  })
  create(@Body(new ZodPipe(createManualDepositSchema)) body: CreateManualDepositInput) {
    const { customer, target, phone, note, ...deposit } = body;
    return this.transactions.createManualDeposit({
      ...deposit,
      // The same payload shape a source sends; absent fields are left out.
      payload: Object.fromEntries(
        Object.entries({ customer, target, phone, note }).filter(([, v]) => v !== undefined),
      ),
    });
  }
}
