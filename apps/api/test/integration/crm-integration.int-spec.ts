/**
 * Integration tests for the CRM integration against the real DB. They guard the
 * behaviour that matters to a company: the demo inbox shows ONE evolving record
 * per transaction (pending → completed → reversed, matched by reference), a
 * delivery to the built-in demo target is captured in-process, and a delivery
 * to an unreachable/unsafe URL is retried with backoff and finally FAILED — it
 * is never silently dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionResponse } from '@app/shared';
import { PrismaService } from '../../src/database/prisma.service';
import { CrmConfigService } from '../../src/modules/crm/crm-config.service';
import { CrmDeliveryService } from '../../src/modules/crm/crm-delivery.service';
import { CrmDemoInboxService } from '../../src/modules/crm/crm-demo-inbox.service';
import { CrmDispatchService } from '../../src/modules/crm/crm-dispatch.service';
import { buildHarness, createCompany, type Harness } from './harness';

const API_PUBLIC_URL = 'http://localhost:3001/v1';

const fakeRealtime = {
  company: () => undefined,
} as unknown as import('../../src/modules/realtime/realtime.service').RealtimeService;

const fakeConfig = {
  get: (key: string) => (key === 'API_PUBLIC_URL' ? API_PUBLIC_URL : undefined),
} as unknown as import('@nestjs/config').ConfigService<
  import('../../src/config/env.schema').Env,
  true
>;

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
  delivery = new CrmDeliveryService(prisma, fakeConfig, demoInbox);
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
    netAmount: '24.50',
    status: 'COMPLETED',
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

describe('CRM delivery retry/backoff', () => {
  it('retries an unsafe/unreachable URL with backoff, then marks it FAILED', async () => {
    const { companyId } = await createCompany(h);
    // A private address is rejected by the SSRF guard at send time, so every
    // attempt fails — exactly the bookkeeping we want to prove.
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

    // First attempt → RETRYING, attempts=1, nextRetryAt scheduled.
    await delivery.deliver(row.id);
    let cur = await prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.findUnique({ where: { id: row.id } }),
    );
    expect(cur!.status).toBe('RETRYING');
    expect(cur!.attempts).toBe(1);
    expect(cur!.nextRetryAt).not.toBeNull();

    // Drive it to exhaustion.
    for (let i = 0; i < 10 && cur!.status === 'RETRYING'; i++) {
      await delivery.deliver(row.id);
      cur = await prisma.runAsAdmin((tx) =>
        tx.webhookDelivery.findUnique({ where: { id: row.id } }),
      );
    }
    expect(cur!.status).toBe('FAILED');
    expect(cur!.nextRetryAt).toBeNull();
    expect(cur!.attempts).toBeGreaterThanOrEqual(6);
  });
});
