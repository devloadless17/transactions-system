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
  createCommissionRuleSchema,
  listCommissionRulesQuerySchema,
  updateCommissionRuleSchema,
  UserRole,
  type CreateCommissionRuleInput,
  type ListCommissionRulesQuery,
  type UpdateCommissionRuleInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { CommissionsService } from './commissions.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/commission-rules')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Post()
  @UsePipes(new ZodPipe(createCommissionRuleSchema))
  @Audited({
    action: 'commission_rule.created',
    entityType: 'commission_rule',
    idFrom: 'result.id',
  })
  async create(@Body() body: CreateCommissionRuleInput) {
    return this.commissions.create(body);
  }

  @Get()
  async list(@Query(new ZodPipe(listCommissionRulesQuerySchema)) query: ListCommissionRulesQuery) {
    return this.commissions.list(query);
  }

  @Patch(':id')
  @Audited({
    action: 'commission_rule.updated',
    entityType: 'commission_rule',
    idFrom: 'params.id',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCommissionRuleSchema)) body: UpdateCommissionRuleInput,
  ) {
    return this.commissions.update(id, body);
  }

  @Post(':id/deactivate')
  @Audited({
    action: 'commission_rule.deactivated',
    entityType: 'commission_rule',
    idFrom: 'params.id',
  })
  async deactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commissions.deactivate(id);
  }

  // Hard delete is destructive (the rule is gone, not just disabled), so it is
  // narrowed to SUPER_ADMIN — overriding the controller-wide role set. Operators
  // can still disable a rule via the deactivate endpoint above.
  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @Audited({
    action: 'commission_rule.deleted',
    entityType: 'commission_rule',
    idFrom: 'params.id',
  })
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commissions.remove(id);
  }
}
