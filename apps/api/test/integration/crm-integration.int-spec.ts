/**
 * Integration tests for the CRM integration against the real DB. They guard the
 * behaviour that matters to a company: the demo inbox shows ONE evolving record
 * per transaction (pending → completed → reversed, matched by reference), a
 * delivery to the built-in demo target is captured in-process, and a delivery
 * to an unreachable/unsafe URL is retried with backoff and finally FAILED — it
 * is never silently dropped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionResponse } from '@app/shared';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import type { Env } from '../../src/config/env.schema';
import { CrmConfigService } from '../../src/modules/crm/crm-config.service';
import { CrmDeliveryService } from '../../src/modules/crm/crm-delivery.service';
import { CrmDemoInboxService } from '../../src/modules/crm/crm-demo-inbox.service';
import { CrmDispatchService } from '../../src/modules/crm/crm-dispatch.service';
import { buildHarness, createCompany, type Harness } from './harness';

const API_PUBLIC_URL = 'http://localhost:3001/v1';

const fakeRealtime = {
  company: () => undefined,
} as unknown as RealtimeService;

const fakeConfig = {
  get: (key: string) => (key === 'API_PUBLIC_URL' ? API_PUBLIC_URL : undefined),
} as unknown as ConfigService<Env, true>;

// Pass-through cache: the delivery sweep's distributed lock always "acquires"
// (single-process test) and unlock is a no-op.
const fakeCache = {
  tryLock: async () => 'test-lock',
  unlock: async () => undefined,
} as unknown as CacheService;

let h: Harness;
let prisma: PrismaService;
let config: CrmConfigService;
let dispatch: CrmDispatchService;
let demoInbox: CrmDemoInboxService;
let delivery: CrmDeliveryService;

beforeAll(async () => {
  h = buildHarness();
  prisma = h.prisma;
  await prisma.$connect();
  demoInbox = new CrmDemoInboxService(prisma, fakeRealtime);
  delivery = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
  dispatch = new CrmDispatchService(prisma, delivery);
  config = new CrmConfigService(prisma, fakeConfig, fakeRealtime);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Poll until `fn` returns a truthy value or the timeout elapses (fire-and-forget paths). */
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function txResponse(
  companyId: string,
  over: Partial<TransactionResponse> = {},
): TransactionResponse {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    companyId,
    sourceId: '00000000-0000-0000-0000-0000000000aa',
    sourceCode: 'whish',
    externalTransactionId: '10231',
    amount: '25.00',
    currency: 'USD',
    commissionAmount: '0.50',
    networkFeeAmount: '0',
    netAmount: '24.50',
    status: 'COMPLETED',
    refunded: false,
    refundedAt: null,
    customer: 'John Doe',
    target: null,
    phone: '+9610000000',
    note: 'Order #1234',
    processedAt: '2026-06-04T12:00:00.000Z',
    createdAt: '2026-06-04T12:00:00.000Z',
    ...over,
  };
}

describe('CRM config', () => {
  it('enableDemo wires the demo inbox and reports it as connected', async () => {
    const { companyId } = await createCompany(h);
    const cfg = await config.enableDemo(companyId);
    expect(cfg.enabled).toBe(true);
    expect(cfg.hasApiKey).toBe(true);
    expect(cfg.demoUrl).toBe(cfg.apiUrl);
    expect(cfg.apiUrl).toContain('/crm-demo/');
  });
});

describe('CRM dispatch → demo inbox lifecycle', () => {
  it('shows one record per reference, evolving pending → completed → reversed', async () => {
    const { companyId } = await createCompany(h);
    await config.enableDemo(companyId);

    // 1. Whish link created (PENDING)
    dispatch.emitWhish({
      companyId,
      externalId: 10231,
      amount: '25.00',
      currency: 'USD',
      invoice: 'Order #1234',
      event: 'transaction.pending',
    });
    let row = await waitFor(() =>
      prisma.runAsTenant(companyId, (tx) =>
        tx.crmDemoEvent.findUnique({
          where: { companyId_reference: { companyId, reference: 'whish:10231' } },
        }),
      ),
    );
    expect(row.status).toBe('PENDING');

    // 2. Settlement (COMPLETED) — same reference upserts the SAME row.
    dispatch.emitFromTransaction(txResponse(companyId), 'transaction.completed');
    row = await waitFor(async () => {
      const r = await prisma.runAsTenant(companyId, (tx) =>
        tx.crmDemoEvent.findUnique({
          where: { companyId_reference: { companyId, reference: 'whish:10231' } },
        }),
      );
      return r?.status === 'COMPLETED' ? r : null;
    });

    // 3. Reversal — same reference flips to REVERSED.
    dispatch.emitFromTransaction(
      txResponse(companyId, { status: 'REVERSED' }),
      'transaction.reversed',
    );
    row = await waitFor(async () => {
      const r = await prisma.runAsTenant(companyId, (tx) =>
        tx.crmDemoEvent.findUnique({
          where: { companyId_reference: { companyId, reference: 'whish:10231' } },
        }),
      );
      return r?.status === 'REVERSED' ? r : null;
    });

    // Exactly one record for this reference the whole way through.
    const all = await prisma.runAsTenant(companyId, (tx) =>
      tx.crmDemoEvent.findMany({ where: { companyId } }),
    );
    expect(all).toHaveLength(1);

    // And each step left a DELIVERED webhook_deliveries row.
    const delivered = await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.count({ where: { companyId, status: 'DELIVERED' } }),
    );
    expect(delivered).toBe(3);
  });

  it('does not dispatch when the CRM is not enabled', async () => {
    const { companyId } = await createCompany(h);
    dispatch.emitFromTransaction(txResponse(companyId), 'transaction.completed');
    // Give the fire-and-forget a moment; nothing should be enqueued.
    await new Promise((r) => setTimeout(r, 150));
    const count = await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.count({ where: { companyId } }),
    );
    expect(count).toBe(0);
  });
});

describe('CRM delivery fail-fast', () => {
  it('marks an unsafe/private URL FAILED on the first attempt (no retry storm)', async () => {
    const { companyId } = await createCompany(h);
    // A private address is rejected by the SSRF guard at send time. That is a
    // permanent config error (a re-pointed/internal CRM URL), not a transient
    // failure, so it must FAIL immediately rather than retry for hours.
    const payload = {
      event: 'transaction.completed',
      reference: 'omt:x',
      sentAt: 'now',
      transaction: {},
    };
    const row = await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.create({
        data: {
          companyId,
          eventType: 'transaction.completed',
          payload,
          targetUrl: 'https://10.0.0.1/hook',
          status: 'PENDING',
        },
        select: { id: true },
      }),
    );

    await delivery.deliver(row.id);
    const cur = await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.findUnique({ where: { id: row.id } }),
    );
    expect(cur!.status).toBe('FAILED');
    expect(cur!.attempts).toBe(1);
    expect(cur!.nextRetryAt).toBeNull();
  });
});

describe('CRM delivery shutdown', () => {
  it('a shutdown stops the sweep between deliveries — the one in progress finishes', async () => {
    const { companyId } = await createCompany(h);
    const payload = {
      event: 'transaction.completed',
      reference: 'omt:x',
      sentAt: 'now',
      transaction: {},
    };
    await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.createMany({
        data: [1, 2, 3].map(() => ({
          companyId,
          eventType: 'transaction.completed',
          payload,
          targetUrl: 'https://10.0.0.1/hook',
          status: 'PENDING' as const,
        })),
      }),
    );
    // A fresh instance: requestStop() is permanent for the one it is called on.
    const sweeper = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
    const attempted: string[] = [];
    vi.spyOn(sweeper, 'deliver').mockImplementation(async (id: string) => {
      attempted.push(id);
      sweeper.requestStop(); // the deploy's SIGTERM arrives during this delivery
    });

    await (sweeper as unknown as { sweep: () => Promise<void> }).sweep();

    // The delivery in progress ran; no other was started.
    expect(attempted).toHaveLength(1);
  });
});

describe('CRM delivery under load — each status sent once, fairly, without delay', () => {
  /** `count` due deliveries to `companyId`'s demo CRM, created `ageMs` ago. */
  async function dueRows(companyId: string, count: number, ageMs = 0): Promise<string[]> {
    const cfg = await config.enableDemo(companyId);
    const at = new Date(Date.now() - ageMs);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await prisma.runAsAdmin((tx) =>
        tx.webhookDelivery.create({
          data: {
            companyId,
            eventType: 'transaction.completed',
            payload: {
              event: 'transaction.completed',
              reference: `whish:load-${i}`,
              sentAt: at.toISOString(),
              transaction: { status: 'COMPLETED', occurredAt: at.toISOString() },
            },
            targetUrl: cfg.apiUrl!,
            status: 'PENDING',
            nextRetryAt: at,
          },
          select: { id: true },
        }),
      );
      ids.push(row.id);
    }
    return ids;
  }
  const statusOf = async (ids: string[]) =>
    prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.findMany({
        where: { id: { in: ids } },
        select: { status: true, attempts: true },
      }),
    );
  const sweepOnce = (svc: CrmDeliveryService) =>
    (svc as unknown as { sweep: () => Promise<void> }).sweep();

  it('the first attempt and the sweep never send the same delivery twice', async () => {
    const { companyId } = await createCompany(h);
    // A first attempt that waited in line past its head start: the sweep may
    // now take the row too — both race for it.
    const firstAttemptAt = new Date(Date.now() - 1_000);
    const [id] = await dueRows(companyId, 1, 1_000);
    await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.update({ where: { id: id! }, data: { nextRetryAt: firstAttemptAt } }),
    );
    const svc = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
    const received = vi.spyOn(demoInbox, 'receive');

    await Promise.all([
      svc.deliver(id!, firstAttemptAt),
      svc.deliver(id!),
      sweepOnce(svc),
      svc.deliver(id!, firstAttemptAt),
    ]);

    expect(received.mock.calls.filter(([co]) => co === companyId)).toHaveLength(1);
    expect(await statusOf([id!])).toEqual([{ status: 'DELIVERED', attempts: 1 }]);
    received.mockRestore();
  });

  it('a first attempt the sweep already took is not sent again', async () => {
    const { companyId } = await createCompany(h);
    const firstAttemptAt = new Date(Date.now() + 60_000);
    const [id] = await dueRows(companyId, 1);
    // The sweep has it (claimed, in flight elsewhere): its due time moved on.
    await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.update({
        where: { id: id! },
        data: { nextRetryAt: new Date(Date.now() + 30_000) },
      }),
    );
    const svc = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
    const received = vi.spyOn(demoInbox, 'receive');

    await svc.deliver(id!, firstAttemptAt);

    expect(received.mock.calls.filter(([co]) => co === companyId)).toHaveLength(0);
    received.mockRestore();
  });

  it('one sweep works through a whole backlog, not one batch per tick', async () => {
    const ids: string[] = [];
    for (let c = 0; c < 6; c++) {
      const { companyId } = await createCompany(h);
      ids.push(...(await dueRows(companyId, 75, 60_000)));
    }
    const svc = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);

    await sweepOnce(svc); // 450 due: more than one batch of 200

    const rows = await statusOf(ids);
    expect(rows.filter((r) => r.status === 'DELIVERED')).toHaveLength(ids.length);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('a company with a large backlog cannot hold up another company', async () => {
    const big = await createCompany(h);
    const bigIds = await dueRows(big.companyId, 260, 120_000); // older, so first in line
    const small = await createCompany(h);
    const [smallId] = await dueRows(small.companyId, 1, 1_000);
    const svc = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
    const order: string[] = [];
    const deliver = svc.deliver.bind(svc);
    vi.spyOn(svc, 'deliver').mockImplementation(async (id: string, at?: Date) => {
      order.push(id);
      return deliver(id, at);
    });

    await sweepOnce(svc);

    // In the very first batch — the big company's share of it (25) and the
    // small one — though 260 older deliveries were due before it.
    const firstBatch = order.slice(0, 26);
    expect(firstBatch).toContain(smallId);
    expect(firstBatch.filter((id) => bigIds.includes(id))).toHaveLength(25);
    expect((await statusOf([...bigIds, smallId!])).every((r) => r.status === 'DELIVERED')).toBe(
      true,
    );
  });
});
