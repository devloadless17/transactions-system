import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { TelegramClient } from '../telegram/telegram.client';
import { NotificationsService } from './notifications.service';

/**
 * Guards the Telegram fan-out gate in `requestSubmitted()`:
 * loads/payouts always alert; withdrawals ONLY when the caller supplies a
 * `manualActionReason` (i.e. auto-approval won't take them).
 */
function makeService() {
  const notifyRequest = vi.fn();
  const telegram = { notifyRequest } as unknown as TelegramClient;
  const realtime = { admin: vi.fn(), company: vi.fn() } as unknown as RealtimeService;

  const tx = {
    company: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Trading' }) },
    notification: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;

  return { svc: new NotificationsService(prisma, realtime, telegram), notifyRequest };
}

const base = { companyId: 'c-1', entityId: 'e-1', amount: '100', currency: 'USD' };

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

  it('does NOT alert for a withdrawal that will auto-approve (no reason)', async () => {
    await svc.requestSubmitted({ ...base, flow: 'WITHDRAWAL' });
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('does NOT alert for a withdrawal with an explicitly null reason', async () => {
    await svc.requestSubmitted({ ...base, flow: 'WITHDRAWAL', manualActionReason: null });
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('alerts for a withdrawal that needs a human, forwarding the reason', async () => {
    await svc.requestSubmitted({
      ...base,
      flow: 'WITHDRAWAL',
      manualActionReason: 'CASH withdrawal',
    });
    expect(notifyRequest).toHaveBeenCalledTimes(1);
    expect(notifyRequest.mock.calls[0][0]).toMatchObject({
      flow: 'WITHDRAWAL',
      reason: 'CASH withdrawal',
    });
  });

  it('an empty-string reason does not alert (treated as "no reason")', async () => {
    await svc.requestSubmitted({ ...base, flow: 'WITHDRAWAL', manualActionReason: '' });
    expect(notifyRequest).not.toHaveBeenCalled();
  });

  it('still alerts when the in-app notification write fails', async () => {
    const notifyRequest2 = vi.fn();
    const telegram = { notifyRequest: notifyRequest2 } as unknown as TelegramClient;
    const realtime = { admin: vi.fn(), company: vi.fn() } as unknown as RealtimeService;
    const prisma = {
      runAsAdmin: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PrismaService;
    const svc2 = new NotificationsService(prisma, realtime, telegram);

    await expect(svc2.requestSubmitted({ ...base, flow: 'PAYOUT' })).resolves.toBeUndefined();
    expect(notifyRequest2).toHaveBeenCalledTimes(1);
  });
});
