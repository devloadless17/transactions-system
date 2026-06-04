import { Body, Controller, Delete, Get, Post, Put, UseGuards } from '@nestjs/common';
import { setCrmConfigSchema, UserRole, type SetCrmConfigInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { CrmConfigService } from './crm-config.service';
import { CrmDemoInboxService } from './crm-demo-inbox.service';

/**
 * Company-managed CRM integration. The company points this at their own CRM's
 * POST endpoint (+ the API key their CRM expects); we then POST every
 * transaction's status to it. They can also enable a built-in demo CRM and
 * watch events land in a live preview inbox.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Controller('company/crm')
export class CrmController {
  constructor(
    private readonly config: CrmConfigService,
    private readonly demoInbox: CrmDemoInboxService,
  ) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('config')
  async get(@CurrentUser() user: AuthPrincipal) {
    return this.config.getConfig(companyOf(user));
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Put('config')
  @Audited({ action: 'crm.config_set', entityType: 'company', idFrom: 'principal.companyId' })
  async set(
    @Body(new ZodPipe(setCrmConfigSchema)) body: SetCrmConfigInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.config.setConfig(companyOf(user), body);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Delete('config')
  @Audited({ action: 'crm.config_cleared', entityType: 'company', idFrom: 'principal.companyId' })
  async clear(@CurrentUser() user: AuthPrincipal) {
    return this.config.clear(companyOf(user));
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Post('demo/enable')
  @Audited({ action: 'crm.demo_enabled', entityType: 'company', idFrom: 'principal.companyId' })
  async enableDemo(@CurrentUser() user: AuthPrincipal) {
    return this.config.enableDemo(companyOf(user));
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('demo/inbox')
  async inbox(@CurrentUser() user: AuthPrincipal) {
    return this.demoInbox.list(companyOf(user));
  }
}

function companyOf(user: AuthPrincipal): string {
  if (!user.companyId) throw new ForbiddenError('No company in session');
  return user.companyId;
}
