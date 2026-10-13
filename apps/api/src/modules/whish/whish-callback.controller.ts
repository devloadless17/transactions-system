import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { WhishPaymentsService } from './whish-payments.service';

/** Whish payment confirmations accepted per minute from one IP (see below). */
export const WHISH_CALLBACKS_PER_MINUTE = 3_000;

/**
 * Public Whish callback endpoints. Whish performs a GET to these URLs when a
 * payment completes, preserving the query params we attached (token +
 * externalId). UNAUTHENTICATED by design — the handler never trusts the
 * callback: it matches the token and re-verifies the real status with Whish
 * before settling. We always reply 200 so Whish considers us notified.
 *
 * Throttled (not skipped), but the cap is sized for WHISH, not for an attacker.
 * Every genuine callback comes from Whish's own server (production sees a
 * single address), so this per-IP cap is, in effect, the number of PAID
 * deposits per minute we accept a confirmation for. Paid money must never wait
 * on a rate limit: a callback refused here leaves that deposit to the 60-second
 * reconciliation poller (oldest links first), so a burst of payments would be
 * credited minutes late. The old cap (120/min) was 12x the busiest minute ever
 * seen; this one leaves room for 50 paid deposits per SECOND.
 *
 * It still bounds a single sprayer: the route is unauthenticated and externalId
 * is sequential, but a guess without the per-payment secret token costs one
 * indexed lookup and is rejected before any Whish call or booking.
 */
// Inbound ack FROM Whish: it only keys off HTTP 200, so keep the {received}
// body raw rather than coupling the provider to our API envelope.
@SkipResponseEnvelope()
@Throttle({ default: { limit: WHISH_CALLBACKS_PER_MINUTE, ttl: 60_000 } })
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
