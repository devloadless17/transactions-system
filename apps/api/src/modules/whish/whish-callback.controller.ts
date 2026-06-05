import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Public Whish callback endpoints. Whish performs a GET to these URLs when a
 * payment completes, preserving the query params we attached (token +
 * externalId). UNAUTHENTICATED by design — the handler never trusts the
 * callback: it matches the token and re-verifies the real status with Whish
 * before settling. We always reply 200 so Whish considers us notified.
 *
 * Throttled (not skipped): the route is unauthenticated and externalId is a
 * sequential, enumerable reference, so a generous-but-finite per-IP cap stops
 * an attacker from hammering the DB / burning Whish API quota by spraying
 * guessed ids, while staying well above any real Whish callback volume.
 */
// Inbound ack FROM Whish: it only keys off HTTP 200, so keep the {received}
// body raw rather than coupling the provider to our API envelope.
@SkipResponseEnvelope()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
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
    // Require a positive INTEGER (not just finite): a fractional externalId like
    // "1.5" passes Number.isFinite but makes BigInt(id) throw a RangeError
    // downstream — a 500 on this public, unauthenticated endpoint. Mirror the CRM
    // controller's parseReference guard so a bad ref is a clean no-op 200.
    if (!externalId || !token || !Number.isInteger(id) || id <= 0) return;
    await this.payments.handleCallback(id, token);
  }
}
