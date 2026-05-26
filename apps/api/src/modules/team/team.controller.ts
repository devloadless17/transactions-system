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
import { ForbiddenError } from '../../common/errors/domain.error';
import { TeamService } from './team.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Controller('company/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get()
  async list(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return { data: await this.team.list(user.companyId) };
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Post()
  @Audited({ action: 'team.member_invited', entityType: 'user', idFrom: 'result.member.id' })
  async invite(
    @Body(new ZodPipe(inviteTeamMemberSchema)) body: InviteTeamMemberInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.team.invite(user.companyId, body);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Patch(':id')
  @Audited({ action: 'team.member_updated', entityType: 'user', idFrom: 'params.id' })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateTeamMemberSchema)) body: UpdateTeamMemberInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.team.update(user.companyId, id, user.userId, body);
  }

  @Roles(UserRole.COMPANY_OWNER)
  @Delete(':id')
  @Audited({ action: 'team.member_removed', entityType: 'user', idFrom: 'params.id' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.team.remove(user.companyId, id, user.userId);
  }
}
