import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createAdminUserSchema,
  listAdminUsersQuerySchema,
  updateAdminUserSchema,
  UserRole,
  type CreateAdminUserInput,
  type ListAdminUsersQuery,
  type UpdateAdminUserInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { AdminUsersService } from './admin-users.service';

/**
 * Platform admin management. SUPER_ADMIN only — ADMIN_OPERATORs cannot
 * manage other admins. Company users are handled by /company/team.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  async list(@Query(new ZodPipe(listAdminUsersQuerySchema)) query: ListAdminUsersQuery) {
    return this.adminUsers.list(query);
  }

  @Post()
  @Audited({ action: 'admin_user.created', entityType: 'user', idFrom: 'result.user.id' })
  async create(
    @Body(new ZodPipe(createAdminUserSchema)) body: CreateAdminUserInput,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    return this.adminUsers.create(body, actor.userId);
  }

  @Patch(':id')
  @Audited({ action: 'admin_user.updated', entityType: 'user', idFrom: 'params.id' })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateAdminUserSchema)) body: UpdateAdminUserInput,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    return this.adminUsers.update(id, actor.userId, body);
  }

  @Delete(':id')
  @Audited({ action: 'admin_user.removed', entityType: 'user', idFrom: 'params.id' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() actor: AuthPrincipal) {
    return this.adminUsers.remove(id, actor.userId);
  }
}
