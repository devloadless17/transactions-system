import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { HealthController } from '../../modules/health/health.controller';
import { skipThrottle } from './skip-throttle';

/**
 * Caddy routes API traffic by the health check. A throttled check (429) made
 * Caddy hold every request until the rate window reset — so the checks made
 * inside our network are never counted, while a visitor's stay limited.
 */
const context = (controller: unknown, headers: Record<string, string> = {}, type = 'http') =>
  ({
    getType: () => type,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;
class OtherController {}

describe('skipThrottle', () => {
  afterEach(() => {
    delete process.env.THROTTLE_DISABLED;
  });

  it("never counts a health check from inside the network (Caddy's, Docker's, the release script's)", () => {
    expect(skipThrottle(context(HealthController))).toBe(true);
    expect(skipThrottle(context(HealthController, { 'x-health-check': 'caddy' }))).toBe(true);
  });

  it("a visitor's health check (forwarded by Caddy) stays limited, even if it claims to be Caddy", () => {
    expect(skipThrottle(context(HealthController, { 'x-forwarded-for': '203.0.113.7' }))).toBe(
      false,
    );
    expect(
      skipThrottle(
        context(HealthController, { 'x-forwarded-for': '203.0.113.7', 'x-health-check': 'caddy' }),
      ),
    ).toBe(false);
  });

  it('every other endpoint stays limited, forwarded or not', () => {
    expect(skipThrottle(context(OtherController))).toBe(false);
    expect(skipThrottle(context(OtherController, { 'x-forwarded-for': '203.0.113.7' }))).toBe(
      false,
    );
  });

  it('only http requests are considered', () => {
    expect(skipThrottle(context(HealthController, {}, 'ws'))).toBe(false);
  });

  it('THROTTLE_DISABLED (the e2e suite) skips everything', () => {
    process.env.THROTTLE_DISABLED = 'true';
    expect(skipThrottle(context(OtherController, { 'x-forwarded-for': '203.0.113.7' }))).toBe(true);
  });
});
