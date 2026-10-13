import { describe, expect, it } from 'vitest';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { WHISH_CALLBACKS_PER_MINUTE, WhishCallbackController } from './whish-callback.controller';

/**
 * Whish's payment confirmations all arrive from Whish's own server, so the
 * per-IP cap on this route is really "paid deposits per minute we accept a
 * confirmation for". Paid money must never wait on a rate limit — a refused
 * confirmation falls back to the 60s poller and the deposit is credited late.
 */
describe('Whish callback throttle', () => {
  it('is applied to the controller with the documented per-minute cap', () => {
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, WhishCallbackController)).toBe(
      WHISH_CALLBACKS_PER_MINUTE,
    );
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, WhishCallbackController)).toBe(60_000);
  });

  it('leaves room for far more paid deposits per minute than real peaks', () => {
    // Busiest minute ever seen in production (2026-10): 10 Whish deposits.
    // The cap must absorb a burst of thousands from Whish's single address.
    expect(WHISH_CALLBACKS_PER_MINUTE).toBeGreaterThanOrEqual(1_000);
  });
});
