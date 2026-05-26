import {
  Body,
  Controller,
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
import { CommissionsService } from './commissions.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/commission-rules')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Post()
  @UsePipes(new ZodPipe(createCommissionRuleSchema))
  async create(@Body() body: CreateCommissionRuleInput) {
    return this.commissions.create(body);
  }

  @Get()
  async list(@Query(new ZodPipe(listCommissionRulesQuerySchema)) query: ListCommissionRulesQuery) {
    return this.commissions.list(query);
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateCommissionRuleSchema)) body: UpdateCommissionRuleInput,
  ) {
    return this.commissions.update(id, body);
  }

  @Post(':id/deactivate')
  async deactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commissions.deactivate(id);
  }
}
