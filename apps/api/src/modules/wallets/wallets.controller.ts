import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { UserRole } from '@app/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { WalletsService } from './wallets.service';
import { ForbiddenError } from '../../common/errors/domain.error';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  // Company users see their own wallets.
  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/wallets')
  async myWallets(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return { data: await this.wallets.listByCompany(user.companyId) };
  }

  // Admins can inspect any company's wallets.
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/companies/:companyId/wallets')
  async companyWallets(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    return { data: await this.wallets.listByCompany(companyId) };
  }
}
