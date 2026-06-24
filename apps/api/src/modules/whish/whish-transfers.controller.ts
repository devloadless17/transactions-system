import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  listWhishTransfersQuerySchema,
  sendWhishTransferSchema,
  updateWhishSessionSchema,
  UserRole,
  type ListWhishTransfersQuery,
  type SendWhishTransferInput,
  type UpdateWhishSessionInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { NotFoundError } from '../../common/errors/domain.error';
import { WhishTransfersService } from './whish-transfers.service';
import { WhishSessionStore } from './whish-session.store';

/**
 * SUPER_ADMIN-only outbound whish-to-whish transfers ("Transfer Money" tool) and
 * the editor for the captured Whish consumer-app session that signs them. Shares
 * the /admin/whish prefix with WhishAdminController (no route collisions).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/whish')
export class WhishTransfersController {
  constructor(
    private readonly transfers: WhishTransfersService,
    private readonly session: WhishSessionStore,
  ) {}

  @Post('transfers')
  @Audited({ action: 'whish.transfer.send', entityType: 'whish_transfer', idFrom: 'result.id' })
  async send(
    @Body(new ZodPipe(sendWhishTransferSchema)) body: SendWhishTransferInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.transfers.sendTransfer(body, { source: 'ADMIN', actorId: user.userId });
  }

  @Get('transfers')
  async list(@Query(new ZodPipe(listWhishTransfersQuerySchema)) query: ListWhishTransfersQuery) {
    return this.transfers.listTransfers(query);
  }

  @Get('transfers/:id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.transfers.getById(id);
    if (!row) throw new NotFoundError('Transfer', id);
    return row;
  }

  /** Non-secret status of the captured W2W session (never returns secrets). */
  @Get('w2w/session')
  async sessionStatus() {
    return this.session.status();
  }

  /** Paste a freshly captured Whish app session (rotate creds, reseed counter). */
  @Put('w2w/session')
  @Audited({ action: 'whish.w2w.session_updated', entityType: 'whish_session' })
  async updateSession(@Body(new ZodPipe(updateWhishSessionSchema)) body: UpdateWhishSessionInput) {
    return this.session.updateCredentials(body);
  }
}
