import { Controller, Get, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Public Whish callback endpoints. Whish performs a GET to these URLs when a
 * payment completes, preserving the query params we attached (token +
 * externalId). UNAUTHENTICATED by design — the handler never trusts the
 * callback: it matches the token and re-verifies the real status with Whish
 * before settling. We always reply 200 so Whish considers us notified.
 */
@SkipThrottle()
@Controller('whish/callback')
export class WhishCallbackController {
  constructor(private readonly payments: WhishPaymentsService) {}

  @Get('success')
  async success(
    @Query('externalId') externalId?: string,
    @Query('token') token?: string,
  ): Promise<{ received: boolean }> {
    await this.settle(externalId, token);
    return { received: true };
  }

  @Get('failure')
  async failure(
    @Query('externalId') externalId?: string,
    @Query('token') token?: string,
  ): Promise<{ received: boolean }> {
    await this.settle(externalId, token);
    return { received: true };
  }

  private async settle(externalId?: string, token?: string): Promise<void> {
    const id = Number(externalId);
    if (!externalId || !token || !Number.isFinite(id)) return;
    await this.payments.handleCallback(id, token);
  }
}
