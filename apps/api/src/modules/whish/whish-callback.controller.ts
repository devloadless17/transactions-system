/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { RateLimitError } from '../../common/errors/domain.error';
import { ApiKeyRateLimitStore } from '../api-keys/api-key-rate-limit.store';
import { WhishPaymentsService } from './whish-payments.service';

const WINDOW_SECONDS = 60;
/**
 * FAKE callbacks (unknown id, wrong token, malformed) accepted per client IP per
 * minute before that IP is refused. Genuine callbacks never count.
 */
export const FAILED_CALLBACKS_PER_MINUTE = 60;
/** How long an address that sent a genuine callback is never refused. */
const TRUSTED_TTL_SECONDS = 24 * 3600;

/**
 * Public Whish callback endpoints. Whish performs a GET to these URLs when a
 * payment completes, preserving the query params we attached (token +
 * externalId). UNAUTHENTICATED by design — the handler never trusts the
 * callback: it matches the token and re-verifies the real status with Whish
 * before settling. We always reply 200 so Whish considers us notified.
 *
 * A genuine callback is NEVER rate-limited, however many arrive. Each one is a
 * customer's deposit that Whish has already collected, and all of them come
 * from Whish's own server (production sees a single address) — so any per-IP
 * request cap would really be a cap on how many paid deposits a minute we
 * accept, and a refused one waits for the reconciliation poller.
 *
 * What IS limited is fakes — exactly like failed API keys: an unknown id, a
 * wrong token or a malformed request counts against the sender's IP, and past
 * FAILED_CALLBACKS_PER_MINUTE that IP is refused for the rest of the minute.
 * (A guess costs only one indexed lookup, and the per-payment token is
 * unguessable; the budget just stops a sprayer loading the database.) An
 * address that has sent a genuine callback is trusted for a day and is never
 * refused, so Whish cannot be locked out by an attacker sharing nothing with
 * it but this URL. With no client IP the limiter is skipped (one shared bucket
 * could be filled by one sprayer), and it fails OPEN on a counter outage.
 */
// Inbound ack FROM Whish: it only keys off HTTP 200, so keep the {received}
// body raw rather than coupling the provider to our API envelope.
@SkipResponseEnvelope()
@SkipThrottle()
@Controller('whish/callback')
export class WhishCallbackController {
  constructor(
    private readonly payments: WhishPaymentsService,
    private readonly limits: ApiKeyRateLimitStore,
  ) {}

  @Get('success')
  async success(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('externalId') externalId?: string,
    @Query('token') token?: string,
  ): Promise<{ received: boolean }> {
    await this.settle(req, res, externalId, token);
    return { received: true };
  }

  @Get('failure')
  async failure(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('externalId') externalId?: string,
    @Query('token') token?: string,
  ): Promise<{ received: boolean }> {
    await this.settle(req, res, externalId, token);
    return { received: true };
  }

  private async settle(
    req: Request,
    res: Response,
    externalId?: string,
    token?: string,
  ): Promise<void> {
    const failKey = req.ip ? `rl:whishcb:fail:${req.ip}` : null;
    const trustKey = req.ip ? `rl:whishcb:ok:${req.ip}` : null;
    if (failKey && trustKey && !(await this.limits.isTrusted(trustKey))) {
      const failed = await this.limits.peek(failKey, WINDOW_SECONDS);
      if (failed && failed.count >= FAILED_CALLBACKS_PER_MINUTE) {
        res.setHeader('RateLimit-Limit', FAILED_CALLBACKS_PER_MINUTE);
        res.setHeader('RateLimit-Remaining', 0);
        res.setHeader('RateLimit-Reset', failed.resetSeconds);
        res.setHeader('Retry-After', failed.resetSeconds);
        throw new RateLimitError({
          limit: FAILED_CALLBACKS_PER_MINUTE,
          windowSeconds: WINDOW_SECONDS,
        });
      }
    }

    const id = Number(externalId);
    // Require a positive INTEGER (not just finite): a fractional externalId like
    // "1.5" passes Number.isFinite but makes BigInt(id) throw a RangeError
    // downstream — a 500 on this public, unauthenticated endpoint. Mirror the CRM
    // controller's parseReference guard so a bad ref is a clean no-op 200.
    const wellFormed = Boolean(externalId && token && Number.isInteger(id) && id > 0);
    const authentic = wellFormed ? await this.payments.handleCallback(id, token!) : false;

    if (!failKey || !trustKey) return;
    // Best-effort bookkeeping: a counter outage never changes the outcome.
    if (authentic) await this.limits.markTrusted(trustKey, TRUSTED_TTL_SECONDS);
    else await this.limits.hit(failKey, WINDOW_SECONDS).catch(() => undefined);
  }
}
