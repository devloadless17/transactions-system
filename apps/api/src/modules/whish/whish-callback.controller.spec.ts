import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import type { Request, Response } from 'express';
import type { ApiKeyRateLimitStore, WindowCount } from '../api-keys/api-key-rate-limit.store';
import type { WhishPaymentsService } from './whish-payments.service';
import { FAILED_CALLBACKS_PER_MINUTE, WhishCallbackController } from './whish-callback.controller';

/**
 * Every genuine Whish callback is a customer's deposit Whish has ALREADY
 * collected, and they all arrive from Whish's own server — so this endpoint must
 * never refuse a genuine one, however many arrive. Only FAKE callbacks (unknown
 * id, wrong token, malformed) are counted, per sender IP, like failed API keys.
 */
const WHISH_IP = '18.213.222.45';
const SPRAYER_IP = '198.51.100.66';

function setup(opts: {
  authentic: boolean;
  failedSoFar?: number;
  trusted?: boolean;
  counterDown?: boolean;
}) {
  const handleCallback = vi.fn().mockResolvedValue(opts.authentic);
  const peek = vi.fn(
    (): Promise<WindowCount | null> =>
      Promise.resolve(opts.counterDown ? null : { count: opts.failedSoFar ?? 0, resetSeconds: 42 }),
  );
  const limits = {
    isTrusted: vi.fn().mockResolvedValue(opts.trusted ?? false),
    peek,
    hit: vi.fn().mockResolvedValue({ count: (opts.failedSoFar ?? 0) + 1, resetSeconds: 42 }),
    markTrusted: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new WhishCallbackController(
    { handleCallback } as unknown as WhishPaymentsService,
    limits as unknown as ApiKeyRateLimitStore,
  );
  const res = { setHeader: vi.fn() } as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
  };
  const call = (ip: string | undefined, externalId?: string, token?: string) =>
    controller.success({ ip } as Request, res, externalId, token);
  return { call, handleCallback, limits, res };
}

describe('WhishCallbackController', () => {
  it('is exempt from the per-IP request throttler (only fakes are limited)', () => {
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, WhishCallbackController)).toBe(true);
  });

  it('a GENUINE callback is accepted even after a flood — and is never counted', async () => {
    // Far past any request cap: 100,000 genuine callbacks this minute.
    const { call, handleCallback, limits } = setup({ authentic: true, failedSoFar: 0 });
    for (let i = 0; i < 5; i++) {
      await expect(call(WHISH_IP, String(7_000_000_000 + i), 'secret')).resolves.toEqual({
        received: true,
      });
    }
    expect(handleCallback).toHaveBeenCalledTimes(5);
    expect(limits.hit).not.toHaveBeenCalled();
    // …and the sender is remembered as trusted.
    expect(limits.markTrusted).toHaveBeenCalledWith(`rl:whishcb:ok:${WHISH_IP}`, 24 * 3600);
  });

  it('a FAKE callback (unknown id or wrong token) is counted against its sender', async () => {
    const { call, limits } = setup({ authentic: false });
    await expect(call(SPRAYER_IP, '123', 'guess')).resolves.toEqual({ received: true });
    expect(limits.hit).toHaveBeenCalledWith(`rl:whishcb:fail:${SPRAYER_IP}`, 60);
    expect(limits.markTrusted).not.toHaveBeenCalled();
  });

  it('a malformed callback is counted without touching the database', async () => {
    for (const [id, token] of [
      [undefined, 'x'],
      ['123', undefined],
      ['1.5', 'x'],
      ['-4', 'x'],
      ['abc', 'x'],
    ] as const) {
      const { call, handleCallback, limits } = setup({ authentic: true });
      await expect(call(SPRAYER_IP, id, token)).resolves.toEqual({ received: true });
      expect(handleCallback).not.toHaveBeenCalled();
      expect(limits.hit).toHaveBeenCalledOnce();
    }
  });

  it(`a sprayer is refused after ${FAILED_CALLBACKS_PER_MINUTE} fakes in a minute — before any lookup`, async () => {
    const { call, handleCallback, res } = setup({
      authentic: false,
      failedSoFar: FAILED_CALLBACKS_PER_MINUTE,
    });
    await expect(call(SPRAYER_IP, '123', 'guess')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
    expect(handleCallback).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 42);
  });

  it('an address that sent a genuine callback is never refused, whatever was counted', async () => {
    const { call, handleCallback, limits } = setup({
      authentic: true,
      failedSoFar: 10_000,
      trusted: true,
    });
    await expect(call(WHISH_IP, '7000000001', 'secret')).resolves.toEqual({ received: true });
    expect(handleCallback).toHaveBeenCalledOnce();
    expect(limits.peek).not.toHaveBeenCalled();
  });

  it('a genuine callback from an untrusted, below-budget address goes through', async () => {
    const { call, handleCallback } = setup({
      authentic: true,
      failedSoFar: FAILED_CALLBACKS_PER_MINUTE - 1,
    });
    await expect(call(WHISH_IP, '7000000001', 'secret')).resolves.toEqual({ received: true });
    expect(handleCallback).toHaveBeenCalledOnce();
  });

  it('fails OPEN when the counter is unavailable, and skips it without a client IP', async () => {
    const down = setup({ authentic: true, counterDown: true });
    await expect(down.call(WHISH_IP, '7000000001', 'secret')).resolves.toEqual({
      received: true,
    });
    expect(down.handleCallback).toHaveBeenCalledOnce();

    const noIp = setup({ authentic: false, failedSoFar: 9999 });
    await expect(noIp.call(undefined, '123', 'guess')).resolves.toEqual({ received: true });
    expect(noIp.limits.peek).not.toHaveBeenCalled();
    expect(noIp.limits.hit).not.toHaveBeenCalled();
  });
});
