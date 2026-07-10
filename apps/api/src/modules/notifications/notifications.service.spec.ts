import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { TelegramClient } from '../telegram/telegram.client';
import { NotificationsService } from './notifications.service';

/**
 * Guards the Telegram fan-out in `requestSubmitted()`:
 *  - loads/payouts always alert;
 *  - withdrawals only when the resolver reports a reason (auto-approval won't take it);
 *  - the resolver runs ONLY after the in-app notification exists, and ONLY when
 *    the bot is configured — its DB reads must never delay or lose the bell.
 */
function makeService(opts: { configured?: boolean } = {}) {
  const notifyRequest = vi.fn().mockResolvedValue(undefined);
  const isConfigured = vi.fn().mockReturnValue(opts.configured ?? true);
  const telegram = { notifyRequest, isConfigured } as unknown as TelegramClient;
  const realtime = { admin: vi.fn(), company: vi.fn() } as unknown as RealtimeService;

  const notificationCreate = vi.fn().mockResolvedValue({});
  const tx = {
    company: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Trading' }) },
    notification: { create: notificationCreate },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;

  return {
    svc: new NotificationsService(prisma, realtime, telegram),
    notifyRequest,
    notificationCreate,
  };
}

const base = { companyId: 'c-1', entityId: 'e-1', amount: '100', currency: 'USD' };
const flush = () => new Promise((r) => setImmediate(r));

describe('NotificationsService.requestSubmitted — Telegram gate', () => {
  let svc: NotificationsService;
  let notifyRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ svc, notifyRequest } = makeService());
  });

  it.each(['PAYOUT', 'LOAD'] as const)('always alerts for %s', async (flow) => {
    await svc.requestSubmitted({ ...base, flow });
    expect(notifyRequest).toHaveBeenCalledTimes(1);
    expect(notifyRequest.mock.calls[0][0]).toMatchObject({ flow, companyName: 'Acme Trading' });
  });

  it('does NOT alert for a withdrawal with no resolver', async () => {
    await svc.requestSubmitted({ ...base, flow: 'WITHDRAWAL' });
    await flush();
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('does NOT alert for a withdrawal that will auto-approve (resolver → null)', async () => {
    await svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      resolveManualActionReason: async () => null,
    });
    await flush();
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('alerts for a withdrawal needing a human, forwarding the reason', async () => {
    await svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      resolveManualActionReason: async () => 'CASH withdrawal',
    });
    await flush();
    expect(notifyRequest).toHaveBeenCalledTimes(1);
    expect(notifyRequest.mock.calls[0][0]).toMatchObject({
      flow: 'WITHDRAWAL',
      reason: 'CASH withdrawal',
    });
  });

  it('a resolver that throws never breaks the caller', async () => {
    await expect(
      svc.requestSubmitted({
        ...base,
        flow: 'WITHDRAWAL',
        resolveManualActionReason: async () => {
          throw new Error('db down');
        },
      }),
    ).resolves.toBeUndefined();
    await flush();
    expect(notifyRequest).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.requestSubmitted — the bell is never held hostage', () => {
  it('creates the in-app notification BEFORE the reason resolver runs', async () => {
    const { svc, notificationCreate } = makeService();
    const order: string[] = [];
    notificationCreate.mockImplementation(() => {
      order.push('in-app');
      return Promise.resolve({});
    });

    await svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      resolveManualActionReason: async () => {
        order.push('resolver');
        return 'CASH withdrawal';
      },
    });
    await flush();
    expect(order).toEqual(['in-app', 'resolver']);
  });

  it('a resolver that never settles cannot suppress the in-app notification', async () => {
    const { svc, notificationCreate } = makeService();
    // Deliberately never resolves — models a hung Postgres read.
    const p = svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      resolveManualActionReason: () => new Promise<string | null>(() => {}),
    });
    await expect(p).resolves.toBeUndefined();
    expect(notificationCreate).toHaveBeenCalledTimes(1);
  });

  it('does NO resolver work when the bot is unconfigured (dev/staging)', async () => {
    const { svc, notifyRequest } = makeService({ configured: false });
    const resolver = vi.fn().mockResolvedValue('CASH withdrawal');

    await svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      resolveManualActionReason: resolver,
    });
    await flush();
    expect(resolver).not.toHaveBeenCalled();
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('still alerts when the in-app notification write fails', async () => {
    const notifyRequest = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      notifyRequest,
      isConfigured: () => true,
    } as unknown as TelegramClient;
    const realtime = { admin: vi.fn(), company: vi.fn() } as unknown as RealtimeService;
    const prisma = {
      runAsAdmin: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PrismaService;
    const svc = new NotificationsService(prisma, realtime, telegram);

    await expect(svc.requestSubmitted({ ...base, flow: 'PAYOUT' })).resolves.toBeUndefined();
    expect(notifyRequest).toHaveBeenCalledTimes(1);
  });
});
