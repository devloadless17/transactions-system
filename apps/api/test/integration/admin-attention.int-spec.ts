/**
 * "Needs your attention" — money a person must look at, against real Postgres.
 *
 * A $5,000 withdrawal sat in PROCESSING for 12 days unseen (Oct 2026): its Whish
 * transfer timed out, auto-approval rightly held it for a person, and the admin
 * queue opens on PENDING. These pin what now surfaces such money:
 *  - GET /admin/operations/attention counts stuck withdrawals (outcome unknown
 *    at once; anything else still PROCESSING after 5 minutes) and Whish
 *    payments flagged needsAttention (the admin list's own filter);
 *  - the admin bell rings once, when a withdrawal is first handed to a person,
 *    and that notification is cleared with the request.
 *
 * Counts are platform-wide and the test DB is shared by every spec file (run
 * one after another), so each check compares against a baseline taken at the
 * same evaluation instant before this file's rows exist.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole, type CreateWithdrawalInput } from '@app/shared';
import { ActivityService } from '../../src/modules/activity/activity.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service';
import type { TelegramClient } from '../../src/modules/telegram/telegram.client';
import {
  addFlowFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  notifiedNeedsDecision,
  type Harness,
} from './harness';

const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

function wishWithdrawal(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: 'USD',
    payout: { method: 'WISH', recipientName: 'Test Recipient', recipientPhone: '+96170000000' },
  };
}

let h: Harness;
let activity: ActivityService;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  activity = new ActivityService(h.prisma, passThroughCache);
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

/** A funded company with `n` WISH withdrawals claimed by auto-approval (PROCESSING). */
async function processingWithdrawals(n: number) {
  const { companyId, userId } = await createCompany(h);
  const sourceId = await createEnabledSource(h, companyId);
  await addFlowFee(h, companyId, 'TRANSACTION', '0');
  await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '1000'));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawal('40'));
    expect(await h.withdrawals.claimForProcessing(w.id, companyId)).toBe(true);
    ids.push(w.id);
  }
  return { companyId, ids };
}

describe('GET /admin/operations/attention — money waiting on a person', () => {
  it('a withdrawal in flight is not stuck; outcome unknown is stuck at once; anything else after 5 minutes', async () => {
    const start = Date.now();
    const inFlight = new Date(start + 60_000); // our rows are < 1 minute in PROCESSING
    const later = new Date(start + 6 * 60_000); // and > 5 minutes by then
    const base = {
      inFlight: (await activity.adminAttention(inFlight)).stuckWithdrawals.count,
      later: (await activity.adminAttention(later)).stuckWithdrawals.count,
    };

    const { companyId, ids } = await processingWithdrawals(2);
    expect((await activity.adminAttention(inFlight)).stuckWithdrawals.count).toBe(base.inFlight);

    // The Whish transfer timed out: auto-approval holds it for a person.
    await h.withdrawals.setAutoMeta(ids[0]!, companyId, {
      status: 'UNKNOWN',
      needsReconcile: true,
    });
    const now = await activity.adminAttention(inFlight);
    expect(now.stuckWithdrawals.count).toBe(base.inFlight + 1);
    expect(now.stuckWithdrawals.oldestAt).not.toBeNull();

    // The other one never finished either: stuck once 5 minutes have passed.
    expect((await activity.adminAttention(later)).stuckWithdrawals.count).toBe(base.later + 2);
  });

  it('counts Whish payments flagged needsAttention, exactly like the admin list filter', async () => {
    const before = (await activity.adminAttention()).whishNeedsAttention.count;
    const { companyId } = await createCompany(h);
    const insert = (metadata: object | undefined) =>
      h.prisma.runAsAdmin((tx) =>
        tx.whishPayment.create({
          data: {
            companyId,
            callbackToken: randomUUID(),
            amount: '50.00',
            currency: 'USD',
            invoice: 'inv-attention',
            status: 'PENDING',
            ...(metadata ? { metadata } : {}),
          },
        }),
      );
    await insert({ needsAttention: true, settlementError: 'company deactivated' });
    await insert({ needsAttention: false });
    await insert(undefined);
    const after = await activity.adminAttention();
    expect(after.whishNeedsAttention.count).toBe(before + 1);
    expect(after.whishNeedsAttention.oldestAt).not.toBeNull();
  });
});

describe('the admin bell — once, when a withdrawal is handed to a person', () => {
  it('notifies on the first needsReconcile only, with the amount to pay', async () => {
    const { companyId, ids } = await processingWithdrawals(2);
    const from = notifiedNeedsDecision.length;

    await h.withdrawals.setAutoMeta(ids[0]!, companyId, {
      status: 'UNKNOWN',
      needsReconcile: true,
    });
    expect(notifiedNeedsDecision.slice(from)).toEqual([
      // The same figure the "new request" notification uses (Money#toString).
      { companyId, entityId: ids[0], amount: '40', currency: 'USD' },
    ]);

    // Flagged again (e.g. a later metadata write) — no second alert.
    await h.withdrawals.setAutoMeta(ids[0]!, companyId, {
      status: 'UNKNOWN',
      needsReconcile: true,
    });
    // Other auto-approval metadata never alerts.
    await h.withdrawals.setAutoMeta(ids[1]!, companyId, { status: 'SUCCESS' });
    expect(notifiedNeedsDecision.length).toBe(from + 1);
  });

  it('the notification reaches every admin and is cleared with the request', async () => {
    const realtime = {
      admin: () => undefined,
      company: () => undefined,
    } as unknown as RealtimeService;
    const telegram = { isConfigured: () => false } as unknown as TelegramClient;
    const notifications = new NotificationsService(h.prisma, realtime, telegram);
    const admin = await h.prisma.runAsAdmin((tx) =>
      tx.user.create({
        data: {
          email: `attention-${randomUUID()}@test.local`,
          passwordHash: 'x',
          role: UserRole.SUPER_ADMIN,
          status: 'ACTIVE',
          companyId: null,
        },
        select: { id: true },
      }),
    );
    const { companyId, ids } = await processingWithdrawals(1);
    const entityId = ids[0]!;

    await notifications.withdrawalNeedsDecision({
      companyId,
      entityId,
      amount: '40.00',
      currency: 'USD',
    });
    const notif = await h.prisma.runAsAdmin((tx) =>
      tx.notification.findFirstOrThrow({
        where: { scope: 'ADMIN', flow: 'WITHDRAWAL', event: 'ATTENTION', entityId },
      }),
    );
    expect(notif.title).toBe('Withdrawal needs a decision');
    expect(notif.body).toContain('40.00 USD');
    expect(notif.link).toBe('/admin/withdrawals');
    expect(notif.companyId).toBeNull(); // ADMIN rows are never visible to a tenant

    // Approved or rejected → no longer something any admin must act on.
    await notifications.clearAdminRequest({ flow: 'WITHDRAWAL', entityId });
    const read = await h.prisma.runAsAdmin((tx) =>
      tx.notificationRead.findFirst({
        where: { notificationId: notif.id, userId: admin.id },
        select: { dismissedAt: true },
      }),
    );
    expect(read?.dismissedAt).not.toBeNull();
  });
});
