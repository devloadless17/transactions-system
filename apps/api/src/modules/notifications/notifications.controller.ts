import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { listNotificationsQuerySchema, UserRole, type ListNotificationsQuery } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { NotificationsService } from './notifications.service';

// Every signed-in actor (admin or company) has a notification inbox; the service
// resolves scope from the session.
const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN_OPERATOR,
  UserRole.BACKOFFICE,
  UserRole.COMPANY_OWNER,
  UserRole.COMPANY_MANAGER,
  UserRole.COMPANY_VIEWER,
] as const;

@UseGuards(CompanyAccessGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Roles(...ALL_ROLES)
  @Get()
  list(
    @Query(new ZodPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.notifications.list(user, query);
  }

  @Roles(...ALL_ROLES)
  @UseGuards(CsrfGuard)
  @Post(':id/read')
  async markRead(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    await this.notifications.markRead(id, user);
    return { ok: true };
  }

  @Roles(...ALL_ROLES)
  @UseGuards(CsrfGuard)
  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthPrincipal) {
    await this.notifications.markAllRead(user);
    return { ok: true };
  }

  @Roles(...ALL_ROLES)
  @UseGuards(CsrfGuard)
  @Post(':id/dismiss')
  async dismiss(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    await this.notifications.dismiss(id, user);
    return { ok: true };
  }

  @Roles(...ALL_ROLES)
  @UseGuards(CsrfGuard)
  @Post('clear-all')
  async clearAll(@CurrentUser() user: AuthPrincipal) {
    await this.notifications.clearAll(user);
    return { ok: true };
  }
}
