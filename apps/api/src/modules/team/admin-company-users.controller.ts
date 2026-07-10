import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  inviteTeamMemberSchema,
  updateTeamMemberSchema,
  UserRole,
  type InviteTeamMemberInput,
  type UpdateTeamMemberInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../common/errors/domain.error';
import { TeamService } from './team.service';

/**
 * Admin-side management of a company's users. Same operations a COMPANY_OWNER
 * gets under /company/team, but scoped to a company picked by URL param so a
 * platform admin can provision/manage users for any tenant. Delegates to the
 * shared TeamService — role assignment stays restricted to company roles.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/companies/:companyId/users')
export class AdminCompanyUsersController {
  constructor(
    private readonly team: TeamService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    await this.assertCompanyExists(companyId);
    return { data: await this.team.list(companyId) };
  }

  @Post()
  @Audited({
    action: 'team.member_invited',
    entityType: 'user',
    idFrom: 'result.member.id',
    companyIdFrom: 'params.companyId',
  })
  async invite(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodPipe(inviteTeamMemberSchema)) body: InviteTeamMemberInput,
  ) {
    await this.assertCompanyExists(companyId);
    return this.team.invite(companyId, body);
  }

  @Patch(':id')
  @Audited({
    action: 'team.member_updated',
    entityType: 'user',
    idFrom: 'params.id',
    companyIdFrom: 'params.companyId',
  })
  async update(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateTeamMemberSchema)) body: UpdateTeamMemberInput,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    await this.assertCompanyExists(companyId);
    return this.team.update(companyId, id, actor.userId, body);
  }

  @Post(':id/reset-password')
  @Audited({
    action: 'team.password_reset',
    entityType: 'user',
    idFrom: 'params.id',
    companyIdFrom: 'params.companyId',
  })
  async resetPassword(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.assertCompanyExists(companyId);
    // `null` actor: a platform admin is never a member of the target company, so
    // the self-reset guard cannot apply. Passed explicitly because the parameter
    // is required — no call site can drop the guard by omission.
    return this.team.resetPassword(companyId, id, null);
  }

  @Delete(':id')
  @Audited({
    action: 'team.member_removed',
    entityType: 'user',
    idFrom: 'params.id',
    companyIdFrom: 'params.companyId',
  })
  async remove(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthPrincipal,
  ) {
    await this.assertCompanyExists(companyId);
    return this.team.remove(companyId, id, actor.userId);
  }

  private async assertCompanyExists(companyId: string) {
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({ where: { id: companyId } }),
    );
    if (!company) throw new NotFoundError('Company', companyId);
  }
}
