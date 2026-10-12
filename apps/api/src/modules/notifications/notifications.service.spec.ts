import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { TelegramClient } from '../telegram/telegram.client';
import type { AuthPrincipal } from '../../common/types/request.types';
import { NotificationsService, adminRequestBody } from './notifications.service';

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

/**
 * BACKOFFICE never learns what the platform charges. An admin "new request"
 * notification is shown to back office too, so its text must only ever name the
 * operator's figure (what to pay / collect) — and a notification written before
 * that figure was recorded must name no amount at all.
 */
describe('admin "new request" notifications and back office', () => {
  it('stores the operator figure as DATA next to the text', async () => {
    const { svc, notificationCreate } = makeService({ configured: false });
    await svc.requestSubmitted({ ...base, amount: '97', flow: 'PAYOUT' });
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data.body).toBe('Acme Trading requested a payout: 97 USD to pay.');
    expect(data.metadata).toMatchObject({
      companyName: 'Acme Trading',
      operatorAmount: '97',
      currency: 'USD',
    });
  });

  it('a load says what to COLLECT', () => {
    expect(adminRequestBody('LOAD', 'Acme', { amount: '103', currency: 'USD' })).toBe(
      'Acme requested a load: 103 USD to collect.',
    );
    expect(adminRequestBody('WITHDRAWAL', null, null)).toBe('A company requested a withdrawal.');
  });

  function listAs(role: string, rows: unknown[]) {
    const tx = {
      notification: {
        findMany: vi.fn().mockResolvedValue(rows),
        count: vi.fn().mockResolvedValue(rows.length),
      },
    };
    const prisma = {
      runAsScoped: vi.fn((_scope: unknown, cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const svc = new NotificationsService(
      prisma,
      { admin: vi.fn(), company: vi.fn() } as unknown as RealtimeService,
      { isConfigured: () => false } as unknown as TelegramClient,
    );
    return svc.list(
      { role, userId: 'u-1', companyId: null } as unknown as AuthPrincipal,
      {
        page: 1,
        pageSize: 20,
        filter: 'active',
      } as never,
    );
  }

  const row = (over: Record<string, unknown>) => ({
    id: 'n-1',
    scope: 'ADMIN',
    flow: 'PAYOUT',
    event: 'REQUESTED',
    title: 'New payout request',
    link: '/admin/payouts',
    entityId: 'p-1',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    reads: [],
    ...over,
  });
  // Written before the operator figure was recorded: it names the REQUESTED
  // amount (100), while the payout row shows back office the net (97).
  const legacy = row({
    body: 'Acme requested a payout of 100 USD.',
    metadata: { companyId: 'c-1', companyName: 'Acme' },
  });
  const current = row({
    body: 'Acme requested a payout: 97 USD to pay.',
    metadata: { companyId: 'c-1', companyName: 'Acme', operatorAmount: '97', currency: 'USD' },
  });

  it("back office never gets a legacy notification's requested amount", async () => {
    const res = await listAs('BACKOFFICE', [legacy]);
    expect(res.data[0]!.body).toBe('Acme requested a payout.');
    expect(res.data[0]!.body).not.toContain('100');
  });

  it('back office gets the operator figure when it was recorded', async () => {
    const res = await listAs('BACKOFFICE', [current]);
    expect(res.data[0]!.body).toBe('Acme requested a payout: 97 USD to pay.');
  });

  it('back office text is rebuilt from data, never the stored sentence', async () => {
    const tampered = row({
      body: 'Acme requested a payout of 100 USD (fee 3).',
      metadata: { companyName: 'Acme', operatorAmount: '97', currency: 'USD' },
    });
    const res = await listAs('BACKOFFICE', [tampered]);
    expect(res.data[0]!.body).toBe('Acme requested a payout: 97 USD to pay.');
  });

  it.each(['SUPER_ADMIN', 'ADMIN_OPERATOR'])('%s keeps the stored text', async (role) => {
    const res = await listAs(role, [legacy, current]);
    expect(res.data.map((n) => n.body)).toEqual([
      'Acme requested a payout of 100 USD.',
      'Acme requested a payout: 97 USD to pay.',
    ]);
  });
});
