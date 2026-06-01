import { Body, Controller, Delete, Get, Post, Put, UseGuards } from '@nestjs/common';
import { setWhishWebhookSchema, UserRole, type SetWhishWebhookInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { WhishWebhookService } from './whish-webhook.service';

/**
 * Company-managed outbound webhook for Whish payment events. The company points
 * this at their CRM so they get pushed `whish.payment.paid` events (signed with
 * a secret) instead of polling.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Controller('company/whish/webhook')
export class WhishWebhookController {
  constructor(private readonly webhooks: WhishWebhookService) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get()
  async get(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.webhooks.getConfig(user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Put()
  @Audited({ action: 'whish.webhook_set', entityType: 'company', idFrom: 'principal.companyId' })
  async set(
    @Body(new ZodPipe(setWhishWebhookSchema)) body: SetWhishWebhookInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.webhooks.setUrl(user.companyId, body.url);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Post('rotate-secret')
  @Audited({
    action: 'whish.webhook_rotated',
    entityType: 'company',
    idFrom: 'principal.companyId',
  })
  async rotate(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.webhooks.rotateSecret(user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Delete()
  @Audited({
    action: 'whish.webhook_cleared',
    entityType: 'company',
    idFrom: 'principal.companyId',
  })
  async clear(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.webhooks.clear(user.companyId);
  }
}
