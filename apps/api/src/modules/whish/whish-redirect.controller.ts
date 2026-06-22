import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  setWhishRedirectConfigSchema,
  UserRole,
  type SetWhishRedirectConfigInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Company-managed default redirect URLs for Whish collect links — where the
 * PAYER's browser lands after a successful / failed payment. A per-link override
 * is also accepted on the create-payment call; these are the saved defaults.
 * Only the customer-facing redirect — the settlement callback URLs stay
 * platform-controlled.
 */
@UseGuards(CompanyAccessGuard, RolesGuard, CsrfGuard)
@Controller('company/whish/redirects')
export class WhishRedirectController {
  constructor(private readonly payments: WhishPaymentsService) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get()
  async get(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.getRedirectConfig(user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Put()
  @Audited({ action: 'whish.redirects_set', entityType: 'company', idFrom: 'principal.companyId' })
  async set(
    @Body(new ZodPipe(setWhishRedirectConfigSchema)) body: SetWhishRedirectConfigInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.setRedirectConfig(user.companyId, body);
  }
}
