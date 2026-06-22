import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  createSourceSchema,
  paginationSchema,
  setSourceFeeRulesSchema,
  updateSourceSchema,
  UserRole,
  type CreateSourceInput,
  type Pagination,
  type SetSourceFeeRulesInput,
  type UpdateSourceInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SourcesService } from './sources.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Controller('admin/sources')
export class SourcesAdminController {
  constructor(private readonly sources: SourcesService) {}

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post()
  @UsePipes(new ZodPipe(createSourceSchema))
  async create(@Body() body: CreateSourceInput) {
    return this.sources.create(body);
  }

  // Read endpoints: any authenticated user can see the source catalog,
  // since they need it to interpret transactions.
  @Get()
  async list(@Query(new ZodPipe(paginationSchema)) query: Pagination) {
    return this.sources.list(query);
  }

  @Get('all')
  async all() {
    return { data: await this.sources.listActiveAll() };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sources.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateSourceSchema)) body: UpdateSourceInput,
  ) {
    return this.sources.update(id, body);
  }

  // Source fee schedule = what the source charges THE PLATFORM per deposit
  // (the platform's cost of funds, used for net-revenue reporting). This is
  // sensitive system/internal data: unlike the source catalog above, these
  // endpoints are gated to platform admins (never BACKOFFICE, never companies).
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get(':id/fee-rules')
  async feeRules(@Param('id', new ParseUUIDPipe()) id: string) {
    return { data: await this.sources.listFeeRules(id) };
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Put(':id/fee-rules')
  async setFeeRules(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(setSourceFeeRulesSchema)) body: SetSourceFeeRulesInput,
  ) {
    return { data: await this.sources.setFeeRules(id, body) };
  }
}
