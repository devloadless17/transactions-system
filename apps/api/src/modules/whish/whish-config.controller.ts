import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@app/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { WhishPaymentsService } from './whish-payments.service';

/** Client config for the Whish UI — which currencies are currently live. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
@Controller('company/whish/config')
export class WhishConfigController {
  constructor(private readonly payments: WhishPaymentsService) {}

  @Get()
  config() {
    return this.payments.clientConfig();
  }
}
