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
  UsePipes,
} from '@nestjs/common';
import {
  createCommissionRuleGroupSchema,
  listCommissionRulesQuerySchema,
  updateCommissionRuleGroupSchema,
  UserRole,
  type CreateCommissionRuleGroupInput,
  type ListCommissionRulesQuery,
  type UpdateCommissionRuleGroupInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { CommissionsService } from './commissions.service';

// A "rule" here is a GROUP: one tier ladder applied to a set of companies and a
// set of operations. The service expands/regroups it into the underlying
// commission_rules rows (one per company × operation × tier) sharing a groupId.
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/commission-rules')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Post()
  @UsePipes(new ZodPipe(createCommissionRuleGroupSchema))
  @Audited({
    action: 'commission_rule.created',
    entityType: 'commission_rule',
    idFrom: 'result.groupId',
  })
  async create(@Body() body: CreateCommissionRuleGroupInput) {
    return this.commissions.createGroup(body);
  }

  @Get()
  async list(@Query(new ZodPipe(listCommissionRulesQuerySchema)) query: ListCommissionRulesQuery) {
    return this.commissions.list(query);
  }

  @Patch(':groupId')
  @Audited({
    action: 'commission_rule.updated',
    entityType: 'commission_rule',
    idFrom: 'params.groupId',
  })
  async update(
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body(new ZodPipe(updateCommissionRuleGroupSchema)) body: UpdateCommissionRuleGroupInput,
  ) {
    return this.commissions.updateGroup(groupId, body);
  }

  @Post(':groupId/deactivate')
  @Audited({
    action: 'commission_rule.deactivated',
    entityType: 'commission_rule',
    idFrom: 'params.groupId',
  })
  async deactivate(@Param('groupId', new ParseUUIDPipe()) groupId: string) {
    return this.commissions.setGroupActive(groupId, false);
  }

  @Post(':groupId/activate')
  @Audited({
    action: 'commission_rule.activated',
    entityType: 'commission_rule',
    idFrom: 'params.groupId',
  })
  async activate(@Param('groupId', new ParseUUIDPipe()) groupId: string) {
    return this.commissions.setGroupActive(groupId, true);
  }

  // Hard delete is destructive (the whole rule is gone, not just disabled), so it
  // is narrowed to SUPER_ADMIN — overriding the controller-wide role set.
  @Delete(':groupId')
  @Roles(UserRole.SUPER_ADMIN)
  @Audited({
    action: 'commission_rule.deleted',
    entityType: 'commission_rule',
    idFrom: 'params.groupId',
  })
  async remove(@Param('groupId', new ParseUUIDPipe()) groupId: string) {
    return this.commissions.removeGroup(groupId);
  }
}
