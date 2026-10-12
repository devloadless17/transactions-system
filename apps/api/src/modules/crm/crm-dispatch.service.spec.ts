import { describe, expect, it, vi } from 'vitest';
import type { CrmEventPayload, TransactionResponse, WithdrawalResponse } from '@app/shared';
import type { PrismaService } from '../../database/prisma.service';
import type { CrmDeliveryService } from './crm-delivery.service';
import { CrmDispatchService } from './crm-dispatch.service';

/**
 * The body a company's CRM actually receives. Built by the REAL dispatcher and
 * read back from the durable `webhook_deliveries` row it enqueues — so a field
 * mapped from the wrong source (e.g. the network fee carrying the commission)
 * fails here. Every money field uses a DISTINCT value for exactly that reason.
 */
function setup(company: { crmEnabled: boolean; crmApiUrl: string | null } | null) {
  const created: Array<{ eventType: string; payload: CrmEventPayload; targetUrl: string }> = [];
  const tx = {
    company: { findUnique: vi.fn().mockResolvedValue(company) },
    webhookDelivery: {
      create: vi.fn((args: { data: (typeof created)[number] }) => {
        created.push(args.data);
        return Promise.resolve({ id: `d-${created.length}` });
      }),
    },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const deliver = vi.fn().mockResolvedValue(undefined);
  const svc = new CrmDispatchService(prisma, { deliver } as unknown as CrmDeliveryService);
  // The dispatcher is fire-and-forget; let its detached promise chain settle.
  const settled = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { svc, created, deliver, settled };
}

const ON = { crmEnabled: true, crmApiUrl: 'https://crm.example/hook' };

const deposit: TransactionResponse = {
  id: '11111111-1111-1111-1111-111111111111',
  companyId: '22222222-2222-2222-2222-222222222222',
  sourceId: '33333333-3333-3333-3333-333333333333',
  sourceCode: 'omt',
  externalTransactionId: 'ext-1',
  amount: '100',
  currency: 'USD',
  commissionAmount: '1.5',
  networkFeeAmount: '1',
  netAmount: '97.5',
  status: 'COMPLETED',
  customer: 'Jane',
  target: 'ACC-9',
  phone: '+96170000000',
  note: 'inv 7',
  processedAt: '2026-10-08T10:00:00.000Z',
  createdAt: '2026-10-08T09:59:00.000Z',
};

const withdrawal = {
  id: '44444444-4444-4444-4444-444444444444',
  companyId: '22222222-2222-2222-2222-222222222222',
  amount: '100',
  currency: 'USD',
  feeAmount: '2',
  networkFeeAmount: '0.75',
  feeApplication: 'ON_TOP',
  netAmount: '100',
  roundingRemainder: '0',
  totalAmount: '102.75',
  status: 'PENDING',
  payoutMethod: 'CASH',
  payoutDetails: null,
  externalReference: null,
  requestedById: null,
  approvedById: null,
  notes: 'pay Sam',
  adminNotes: null,
  processedAt: null,
  createdAt: '2026-10-08T11:00:00.000Z',
  updatedAt: '2026-10-08T11:00:00.000Z',
} as WithdrawalResponse;

describe('CrmDispatchService — the body the CRM receives', () => {
  it('transaction.completed carries the commission AND the network fee, each from its own field', async () => {
    const { svc, created, deliver, settled } = setup(ON);
    svc.emitFromTransaction(deposit, 'transaction.completed');
    await settled();

    expect(created).toHaveLength(1);
    const { eventType, payload, targetUrl } = created[0]!;
    expect(eventType).toBe('transaction.completed');
    expect(targetUrl).toBe('https://crm.example/hook');
    expect(payload.event).toBe('transaction.completed');
    expect(payload.reference).toBe('omt:ext-1');
    expect(payload.transaction).toEqual({
      id: deposit.id,
      status: 'COMPLETED',
      source: 'omt',
      externalTransactionId: 'ext-1',
      amount: '100',
      currency: 'USD',
      netAmount: '97.5',
      commissionAmount: '1.5',
      networkFeeAmount: '1',
      customer: 'Jane',
      tradingAccount: 'ACC-9',
      phone: '+96170000000',
      note: 'inv 7',
      occurredAt: '2026-10-08T10:00:00.000Z',
    });
    // What a company passes on to its own client is exactly this figure.
    expect(payload.transaction!.networkFeeAmount).not.toBe(payload.transaction!.commissionAmount);
    expect(deliver).toHaveBeenCalledWith('d-1');
  });

  it('a company without a network fee gets "0" — the field is always there', async () => {
    const { svc, created, settled } = setup(ON);
    svc.emitFromTransaction(
      { ...deposit, commissionAmount: '2.5', networkFeeAmount: '0', netAmount: '97.5' },
      'transaction.completed',
    );
    await settled();
    expect(created[0]!.payload.transaction).toMatchObject({
      commissionAmount: '2.5',
      networkFeeAmount: '0',
      netAmount: '97.5',
    });
  });

  it('transaction.reversed keeps the same reference and fee breakdown', async () => {
    const { svc, created, settled } = setup(ON);
    svc.emitFromTransaction({ ...deposit, status: 'REVERSED' }, 'transaction.reversed');
    await settled();
    expect(created[0]!.payload.reference).toBe('omt:ext-1');
    expect(created[0]!.payload.transaction).toMatchObject({
      status: 'REVERSED',
      commissionAmount: '1.5',
      networkFeeAmount: '1',
    });
  });

  it('a Whish payment that has not settled yet has no fees: all three are null', async () => {
    const { svc, created, settled } = setup(ON);
    svc.emitWhish({
      companyId: deposit.companyId,
      externalId: 7000000001n,
      amount: '100',
      currency: 'USD',
      invoice: 'inv 7',
      payerPhoneNumber: null,
      event: 'transaction.pending',
    });
    await settled();
    expect(created[0]!.payload.reference).toBe('whish:7000000001');
    expect(created[0]!.payload.transaction).toMatchObject({
      status: 'PENDING',
      netAmount: null,
      commissionAmount: null,
      networkFeeAmount: null,
    });
  });

  it('withdrawal.* mirrors the REST resource: total = net + fee + network fee', async () => {
    const { svc, created, settled } = setup(ON);
    svc.emitWithdrawal(withdrawal, 'withdrawal.pending');
    await settled();
    const body = created[0]!.payload;
    expect(body.reference).toBe(`withdrawal:${withdrawal.id}`);
    expect(body.withdrawal).toMatchObject({
      status: 'PENDING',
      amount: '100',
      totalAmount: '102.75',
      feeAmount: '2',
      networkFeeAmount: '0.75',
      netAmount: '100',
      feeApplication: 'ON_TOP',
      note: 'pay Sam',
    });
  });

  it('sentAt follows the order events were EMITTED in, not the order their writes finish', async () => {
    // pending is emitted first, but its company lookup resolves LAST.
    const created: CrmEventPayload[] = [];
    let call = 0;
    const tx = {
      company: {
        findUnique: vi.fn(async () => {
          const mine = call++;
          await new Promise((r) => setTimeout(r, mine === 0 ? 30 : 0));
          return ON;
        }),
      },
      webhookDelivery: {
        create: vi.fn((args: { data: { payload: CrmEventPayload } }) => {
          created.push(args.data.payload);
          return Promise.resolve({ id: `d-${created.length}` });
        }),
      },
    };
    const prisma = {
      runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const svc = new CrmDispatchService(prisma, {
      deliver: vi.fn().mockResolvedValue(undefined),
    } as unknown as CrmDeliveryService);

    svc.emitWithdrawal(withdrawal, 'withdrawal.pending');
    await new Promise((r) => setTimeout(r, 5));
    svc.emitWithdrawal({ ...withdrawal, status: 'COMPLETED' }, 'withdrawal.completed');
    await new Promise((r) => setTimeout(r, 80));

    // The completed row was WRITTEN first …
    expect(created.map((p) => p.event)).toEqual(['withdrawal.completed', 'withdrawal.pending']);
    // … yet a CRM ordering by sentAt still sees pending as the older event.
    const sentAt = (name: string) => Date.parse(created.find((p) => p.event === name)!.sentAt);
    expect(sentAt('withdrawal.pending')).toBeLessThan(sentAt('withdrawal.completed'));
  });

  it('enqueues nothing when the company has no CRM configured', async () => {
    for (const company of [
      null,
      { crmEnabled: false, crmApiUrl: 'https://x' },
      { crmEnabled: true, crmApiUrl: null },
    ]) {
      const { svc, created, settled } = setup(company);
      svc.emitFromTransaction(deposit, 'transaction.completed');
      await settled();
      expect(created).toEqual([]);
    }
  });
});
