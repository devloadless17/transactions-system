/**
 * The behaviours hardened after the 2026-10-12 review of the network fee,
 * pinned against the real database (RLS enforced, real ledger, real wallets):
 *
 *   - a deposit reads the switch AND the rate from the booking snapshot — a
 *     stale "it was on a moment ago" can never charge;
 *   - saving a company's network fee never blocks or fails a deposit in flight;
 *   - an amount no commission tier covers is charged the same way as every
 *     other amount of that flow;
 *   - the operator's "the transfer went through" confirmation only settles a
 *     PROCESSING withdrawal;
 *   - re-reversing a deposit announces nothing twice;
 *   - the activity feed's cached totals never cross tenants;
 *   - back office sees ONE figure per operation and nothing a fee can be
 *     derived from — including for a deposit priced ON_TOP;
 *   - the admin rollups show the network fee wherever they show a volume that
 *     includes it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActivityKind, Money, type CreateWithdrawalInput } from '@app/shared';
import type { CacheService } from '../../src/modules/cache/cache.service';
import {
  backofficeActivityItem,
  backofficeList,
  backofficeLoad,
  backofficePayOut,
  backofficeTransaction,
  backofficeTransactionDetail,
} from '../../src/common/backoffice-view';
import { ConflictError } from '../../src/common/errors/domain.error';
import { ActivityService } from '../../src/modules/activity/activity.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { PlatformAnalyticsService } from '../../src/modules/analytics/platform-analytics.service';
import {
  addFixedFlowFee,
  addFlowFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  legsFor,
  loadInput,
  payoutInput,
  setNetworkFee,
  snapshot,
  USD,
  type FlowOp,
  type Harness,
} from './harness';

/** Money-aware equality so 97 and 97.00000000 compare equal. */
const eq = (a: string | null | undefined, b: string) => a != null && Money.of(a).eq(Money.of(b));

const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

/** A cache that really caches (by key), so key collisions show up as wrong data. */
function memoryCache(): CacheService & { keys(): string[] } {
  const store = new Map<string, unknown>();
  return {
    async wrap<T>(key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
      if (!store.has(key)) store.set(key, await fn());
      return store.get(key) as T;
    },
    keys: () => [...store.keys()],
  } as unknown as CacheService & { keys(): string[] };
}

async function readCsv(file: { getStream(): AsyncIterable<unknown> }): Promise<string[][]> {
  let csv = '';
  for await (const chunk of file.getStream()) csv += String(chunk);
  return csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\n')
    .map((l) => l.split(','));
}

function wishWithdrawalInput(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: USD,
    payout: { method: 'WISH', recipientName: 'Whish Payee', recipientPhone: '+96170000000' },
  };
}

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

/** Fund a company's wallet with a fee-free deposit through a dedicated source. */
async function fund(companyId: string, amount: string): Promise<void> {
  const sourceId = await createEnabledSource(h, companyId);
  await h.prisma.runAsAdmin((tx) =>
    tx.commissionRule.create({
      data: {
        companyId,
        sourceId,
        operationType: 'TRANSACTION',
        feeApplication: 'DEDUCTED',
        minAmount: '0.01',
        maxAmount: '100000000',
        commissionType: 'PERCENTAGE',
        commissionValue: '0',
        priority: 500,
        active: true,
      },
    }),
  );
  await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, amount));
}

/** A commission rule covering only [min, max] — for building ladders with holes. */
async function addTier(
  companyId: string,
  operationType: FlowOp,
  opts: { min: string; max: string | null; dollars: string; application: 'DEDUCTED' | 'ON_TOP' },
): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.commissionRule.create({
      data: {
        companyId,
        sourceId: null,
        operationType,
        feeApplication: opts.application,
        minAmount: opts.min,
        maxAmount: opts.max,
        commissionType: 'FIXED',
        commissionValue: opts.dollars,
        priority: 100,
        active: true,
      },
    }),
  );
}

/** The fresh company + source rows the HTTP ingest controller hands the service. */
async function preload(companyId: string, sourceId: string) {
  const [source, company] = await h.prisma.runAsAdmin((tx) =>
    Promise.all([
      tx.source.findUniqueOrThrow({ where: { id: sourceId } }),
      tx.company.findUniqueOrThrow({ where: { id: companyId } }),
    ]),
  );
  return { source, company };
}

// ---------------------------------------------------------------------------

describe('a deposit prices from ONE snapshot (switch + rate)', () => {
  it('the switch was ON when the request arrived but is OFF when it books → no network fee', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    // The controller read the company while the switch was ON …
    const stale = await preload(companyId, sourceId);
    expect(stale.company.networkFeeEnabled).toBe(true);
    // … then a SUPER_ADMIN switched it off AND changed the rate in the same
    // save (the card keeps the rates when switching off).
    await setNetworkFee(h, companyId, {
      enabled: false,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '2' }],
    });

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId, preloaded: stale },
      ingestInput(companyId, '100'),
    );
    // Not the stale switch with the new 2% rate — a price that was never live.
    expect(eq(txn.networkFeeAmount, '0')).toBe(true);
    expect(eq(txn.commissionAmount, '2')).toBe(true);
    expect(eq(txn.netAmount, '98')).toBe(true);
    const legs = await legsFor(h, companyId, { transactionId: txn.id });
    expect(Object.keys(legs).sort()).toEqual(['AVAILABLE:CREDIT', 'EXTERNAL:DEBIT', 'FEE:CREDIT']);
  });

  it('switch ON throughout → charged at the rate in force when it books', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const fresh = await preload(companyId, sourceId);
    // The rate changes after the request was authenticated, before it books.
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '3' }],
    });
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId, preloaded: fresh },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.networkFeeAmount, '3')).toBe(true);
    expect(eq(txn.netAmount, '95')).toBe(true);
  });

  it('a company with the switch OFF never reads the rate table on a deposit', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    // Rates saved, switch OFF.
    await setNetworkFee(h, companyId, {
      enabled: false,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const off = await preload(companyId, sourceId);
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId, preloaded: off },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.networkFeeAmount, '0')).toBe(true);
    expect(eq(txn.netAmount, '98')).toBe(true);
  });
});

describe('saving the network fee never disturbs a deposit in flight', () => {
  it('a deposit books while the save is still holding its lock, at the price in force before it', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });

    // Pause the REAL setNetworkFee in the middle of its transaction — after it
    // has locked the company row and flipped the switch, before it commits —
    // and book a deposit for that company on another connection meanwhile.
    // The deposit inserts rows with a foreign key to the company, which takes a
    // KEY SHARE lock on that row: a plain FOR UPDATE in the save would make it
    // wait for the save to commit (here: forever, so the 5s guard would fire).
    let booked: Awaited<ReturnType<Harness['transactions']['ingest']>> | undefined;
    const realRunAsAdmin = h.prisma.runAsAdmin.bind(h.prisma);
    const spy = vi.spyOn(h.prisma, 'runAsAdmin').mockImplementationOnce(((
      cb: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) =>
      (realRunAsAdmin as (c: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
        async (tx) => {
          const real = tx as {
            companyNetworkFee: { deleteMany: (a: unknown) => Promise<unknown> };
          };
          const rates = new Proxy(real.companyNetworkFee, {
            get(target, prop, receiver) {
              if (prop !== 'deleteMany') return Reflect.get(target, prop, receiver);
              return async (args: unknown) => {
                booked = await Promise.race([
                  h.transactions.ingest(
                    { kind: 'source', sourceId },
                    ingestInput(companyId, '100'),
                  ),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error('the deposit was blocked by the network-fee save')),
                      5_000,
                    ),
                  ),
                ]);
                return target.deleteMany(args);
              };
            },
          });
          return cb(
            new Proxy(real, {
              get: (t, p, r) => (p === 'companyNetworkFee' ? rates : Reflect.get(t, p, r)),
            }),
          );
        },
        opts,
      )) as never);

    try {
      await setNetworkFee(h, companyId, {
        enabled: false,
        rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '5' }],
      });
    } finally {
      spy.mockRestore();
    }

    // The deposit booked DURING the save, at the configuration that was
    // committed when it ran (1%, switch on) — the uncommitted save is invisible.
    expect(booked).toBeDefined();
    expect(eq(booked!.networkFeeAmount, '1')).toBe(true);
    expect(eq(booked!.netAmount, '97')).toBe(true);
    // And the save itself landed.
    expect(await h.companies.getNetworkFee(companyId)).toEqual({
      enabled: false,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '5' }],
    });
    const s = await snapshot(h, companyId);
    expect(s.balanced).toBe(true);
  });
});

describe('an amount no commission tier covers', () => {
  it('a DEDUCTED withdrawal ladder stays DEDUCTED below its first tier — no flip one cent apart', async () => {
    const { companyId, userId } = await createCompany(h);
    await fund(companyId, '1000');
    // WITHDRAWAL: $2 DEDUCTED from 100 up; nothing configured below 100.
    await addTier(companyId, 'WITHDRAWAL', {
      min: '100',
      max: null,
      dollars: '2',
      application: 'DEDUCTED',
    });
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '5' }],
    });

    const below = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('99.99'));
    expect(below.feeApplication).toBe('DEDUCTED');
    expect(eq(below.feeAmount, '0')).toBe(true);
    expect(eq(below.networkFeeAmount, '5')).toBe(true);
    expect(eq(below.totalAmount, '99.99')).toBe(true);
    expect(eq(below.netAmount, '94.99')).toBe(true);

    const inside = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
    expect(inside.feeApplication).toBe('DEDUCTED');
    expect(eq(inside.feeAmount, '2')).toBe(true);
    expect(eq(inside.networkFeeAmount, '5')).toBe(true);
    expect(eq(inside.totalAmount, '100')).toBe(true);
    expect(eq(inside.netAmount, '93')).toBe(true);

    const s = await snapshot(h, companyId);
    expect(s.balanced).toBe(true);
    expect(eq(s.wallet!.reserved, '199.99')).toBe(true);
  });

  it('an ON_TOP payout ladder stays ON_TOP above its last tier', async () => {
    const { companyId, userId } = await createCompany(h);
    await fund(companyId, '5000');
    await addTier(companyId, 'PAYOUT', {
      min: '0.01',
      max: '1000',
      dollars: '2',
      application: 'ON_TOP',
    });
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '5' }],
    });
    const edge = await h.payouts.request(companyId, userId, payoutInput('1000'));
    expect(edge.feeApplication).toBe('ON_TOP');
    expect(eq(edge.netAmount, '1000')).toBe(true);
    expect(eq(edge.totalAmount, '1007')).toBe(true);

    const above = await h.payouts.request(companyId, userId, payoutInput('1000.01'));
    // Not the PAYOUT default (DEDUCTED): the recipient still gets the full amount.
    expect(above.feeApplication).toBe('ON_TOP');
    expect(eq(above.feeAmount, '0')).toBe(true);
    expect(eq(above.networkFeeAmount, '5')).toBe(true);
    expect(eq(above.netAmount, '1000.01')).toBe(true);
    expect(eq(above.totalAmount, '1005.01')).toBe(true);
  });

  it('a flow with NO rule at all keeps its conventional application', async () => {
    const { companyId, userId } = await createCompany(h);
    await fund(companyId, '500');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
        { operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '1' },
      ],
    });
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('50'));
    expect(w.feeApplication).toBe('ON_TOP');
    expect(eq(w.netAmount, '50')).toBe(true);
    const p = await h.payouts.request(companyId, userId, payoutInput('50'));
    expect(p.feeApplication).toBe('DEDUCTED');
    expect(eq(p.netAmount, '49')).toBe(true);
  });
});

describe('completing a "stuck transfer" only settles a PROCESSING withdrawal', () => {
  it('a PENDING withdrawal is refused: nothing is paid out, nothing is booked', async () => {
    const { companyId, userId } = await createCompany(h);
    await fund(companyId, '200');
    await addFlowFee(h, companyId, 'WITHDRAWAL', '1');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '0.50' }],
    });
    // 50.40 DEDUCTED: commission 0.50, network 0.50 → net 49.40.
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('50.40'));
    expect(w.status).toBe('PENDING');
    expect(eq(w.netAmount, '49.40')).toBe(true);
    const before = await snapshot(h, companyId);

    await expect(
      h.withdrawals.resolveProcessing(w.id, userId, {
        action: 'complete',
        externalReference: 'manual-ref',
      }),
    ).rejects.toThrow(ConflictError);

    const row = await h.withdrawals.getById(w.id, companyId);
    expect(row.status).toBe('PENDING');
    expect(eq(row.roundingRemainder, '0')).toBe(true);
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.wallet!.reserved, before.wallet!.reserved)).toBe(true);
    expect(eq(after.wallet!.available, before.wallet!.available)).toBe(true);
    // Only the reserve legs exist — no EXTERNAL / FEE / NETWORK_FEE settlement.
    const legs = await legsFor(h, companyId, { withdrawalId: w.id });
    expect(Object.keys(legs).sort()).toEqual(['AVAILABLE:DEBIT', 'RESERVED:CREDIT']);
  });

  it('a PROCESSING withdrawal still completes whole-dollar, with both fees', async () => {
    const { companyId, userId } = await createCompany(h);
    await fund(companyId, '200');
    await addFlowFee(h, companyId, 'WITHDRAWAL', '1');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '0.50' }],
    });
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('50.40'));
    expect(await h.withdrawals.claimForProcessing(w.id, companyId)).toBe(true);
    const done = await h.withdrawals.resolveProcessing(w.id, userId, {
      action: 'complete',
      externalReference: 'w2w-ref',
    });
    expect(done.status).toBe('COMPLETED');
    expect(eq(done.roundingRemainder, '0.40')).toBe(true);
    const legs = await legsFor(h, companyId, { withdrawalId: w.id });
    // reserved 50.40 → EXTERNAL 49 + FEE (0.50 + 0.40 remainder) + NETWORK_FEE 0.50
    expect(eq(legs['EXTERNAL:CREDIT'], '49')).toBe(true);
    expect(eq(legs['FEE:CREDIT'], '0.90')).toBe(true);
    expect(eq(legs['NETWORK_FEE:CREDIT'], '0.50')).toBe(true);
    expect((await snapshot(h, companyId)).balanced).toBe(true);
  });
});

describe('reversing an already-reversed deposit', () => {
  it('books nothing and tells the CRM nothing a second time', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );

    const first = await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    expect(first.status).toBe('REVERSED');
    const afterFirst = await snapshot(h, companyId);
    const reversedEvents = () => h.crm.names().filter((n) => n === 'transaction.reversed').length;
    expect(reversedEvents()).toBe(1);
    const ledgerRowsAfterFirst = await h.prisma.runAsAdmin((tx) =>
      tx.ledgerEntry.count({ where: { transactionId: txn.id } }),
    );

    // A stale dialog / a retried request / the loser of two concurrent reversals.
    const second = await h.transactions.reverse(txn.id, { actorId: userId, reason: 'again' });
    expect(second.status).toBe('REVERSED');
    expect(second.id).toBe(txn.id);
    expect(reversedEvents()).toBe(1);
    expect(
      await h.prisma.runAsAdmin((tx) => tx.ledgerEntry.count({ where: { transactionId: txn.id } })),
    ).toBe(ledgerRowsAfterFirst);
    const afterSecond = await snapshot(h, companyId);
    expect(afterSecond.balanced).toBe(true);
    expect(eq(afterSecond.wallet!.available, afterFirst.wallet!.available)).toBe(true);
    expect(eq(afterSecond.networkFeeLedger, '0')).toBe(true);
    expect(eq(afterSecond.feeLedger, '0')).toBe(true);
  });
});

describe('the activity feed never serves one tenant’s total to another', () => {
  const window = { from: '2026-10-01T00:00:00.000Z' };

  it('two companies and the admin asking the same filtered question each get their own count', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    await fund(a.companyId, '10');
    await fund(a.companyId, '20');
    await fund(a.companyId, '30');
    await fund(b.companyId, '40');

    // ONE service with a cache that really caches — as in production.
    const cache = memoryCache();
    const activity = new ActivityService(h.prisma, cache);
    // A filter is set, so balance mode is off and the count is the cached one.
    const query = { page: 1, pageSize: 20, direction: 'IN' as const, ...window };

    const forA = await activity.list({ companyId: a.companyId, query });
    const forB = await activity.list({ companyId: b.companyId, query });
    const forAdmin = await activity.list({ query });

    expect(forA.meta.total).toBe(3);
    expect(forB.meta.total).toBe(1);
    expect(forAdmin.meta.total).toBeGreaterThanOrEqual(4);
    expect(forA.data.every((r) => r.companyId === null)).toBe(true);
    // Asked again in the other order, straight from the cache: still their own.
    expect((await activity.list({ companyId: b.companyId, query })).meta.total).toBe(1);
    expect((await activity.list({ companyId: a.companyId, query })).meta.total).toBe(3);
    // Three callers, three cache entries.
    expect(new Set(cache.keys().filter((k) => k.startsWith('list-count:activity:'))).size).toBe(3);
  });

  it('a company cannot aim the feed at another company with ?companyId=', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    await fund(a.companyId, '10');
    await fund(b.companyId, '40');
    await fund(b.companyId, '50');

    const cache = memoryCache();
    const activity = new ActivityService(h.prisma, cache);
    const query = { page: 1, pageSize: 20, direction: 'IN' as const, ...window };

    // The admin looks at company B first: the true count (2) is now cached.
    const adminOnB = await activity.list({ query: { ...query, companyId: b.companyId } });
    expect(adminOnB.meta.total).toBe(2);
    // Company A passes B's id. The parameter is admin-only: A gets ITS feed.
    const aAimingAtB = await activity.list({
      companyId: a.companyId,
      query: { ...query, companyId: b.companyId },
    });
    expect(aAimingAtB.meta.total).toBe(1);
    expect(aAimingAtB.data).toHaveLength(1);
    expect(eq(aAimingAtB.data[0]!.amount, '10')).toBe(true);
    // …and it did not poison what the admin sees for B.
    expect((await activity.list({ query: { ...query, companyId: b.companyId } })).meta.total).toBe(
      2,
    );
  });
});

describe('back office sees ONE figure per operation — and never a fee', () => {
  let co: { companyId: string; userId: string };
  let activity: ActivityService;
  let onTopDepositId: string;
  let deductedDepositId: string;
  let withdrawalId: string;
  let payoutId: string;
  let loadId: string;

  beforeAll(async () => {
    activity = new ActivityService(h.prisma, passThroughCache);
    co = await createCompany(h);
    await fund(co.companyId, '1000');

    // Deposit priced ON_TOP: customer pays 100; 2 + 1 are charged on top.
    const onTopSource = await createEnabledSource(h, co.companyId);
    await h.prisma.runAsAdmin((tx) =>
      tx.commissionRule.create({
        data: {
          companyId: co.companyId,
          sourceId: onTopSource,
          operationType: 'TRANSACTION',
          feeApplication: 'ON_TOP',
          minAmount: '0.01',
          maxAmount: '100000000',
          commissionType: 'FIXED',
          commissionValue: '2',
          priority: 500,
          active: true,
        },
      }),
    );
    // Deposit priced DEDUCTED on another source: customer pays 200; net 194.
    const deductedSource = await createEnabledSource(h, co.companyId);
    await h.prisma.runAsAdmin((tx) =>
      tx.commissionRule.create({
        data: {
          companyId: co.companyId,
          sourceId: deductedSource,
          operationType: 'TRANSACTION',
          feeApplication: 'DEDUCTED',
          minAmount: '0.01',
          maxAmount: '100000000',
          commissionType: 'FIXED',
          commissionValue: '4',
          priority: 500,
          active: true,
        },
      }),
    );
    await addFixedFlowFee(h, co.companyId, 'WITHDRAWAL', '2', 'ON_TOP');
    await addFixedFlowFee(h, co.companyId, 'PAYOUT', '1');
    await addFixedFlowFee(h, co.companyId, 'LOAD', '2', 'ON_TOP');
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
        { operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '0.50' },
        { operationType: 'LOAD', feeType: 'PERCENTAGE', feeValue: '1' },
      ],
    });

    const onTop = await h.transactions.ingest(
      { kind: 'source', sourceId: onTopSource },
      ingestInput(co.companyId, '100'),
    );
    onTopDepositId = onTop.id;
    expect(eq(onTop.netAmount, '100')).toBe(true); // credited in full
    const ded = await h.transactions.ingest(
      { kind: 'source', sourceId: deductedSource },
      ingestInput(co.companyId, '200'),
    );
    deductedDepositId = ded.id;
    expect(eq(ded.netAmount, '194')).toBe(true); // 200 − 4 − 2

    // Withdrawal 50 ON_TOP → recipient 50, wallet charged 53.
    const w = await h.withdrawals.request(co.companyId, co.userId, cashWithdrawalInput('50'));
    withdrawalId = w.id;
    await h.withdrawals.approve(w.id, co.userId, { externalReference: 'paid-w' });
    // Payout 10 DEDUCTED → recipient 8.50.
    const p = await h.payouts.request(co.companyId, co.userId, payoutInput('10'));
    payoutId = p.id;
    await h.payouts.approve(p.id, co.userId, { externalReference: 'paid-p' });
    // Load 100 ON_TOP → collect 103, credit 100.
    const l = await h.loads.request(co.companyId, co.userId, loadInput('100'));
    loadId = l.id;
    await h.loads.approve(l.id, co.userId, { externalReference: 'cash-l' });
  });

  it('an ON_TOP deposit shows what the customer PAID (100) — never paid + fees (103)', async () => {
    const full = await h.transactions.getById(onTopDepositId);
    // The books say 103 moved (EXTERNAL), and a full admin's activity row agrees.
    const legs = await legsFor(h, co.companyId, { transactionId: onTopDepositId });
    expect(eq(legs['EXTERNAL:DEBIT'], '103')).toBe(true);

    const view = backofficeTransaction(full);
    expect(eq(view.amount, '100')).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/103|commissionAmount|networkFeeAmount|netAmount/);

    const detail = backofficeTransactionDetail(await h.transactions.getDetail(onTopDepositId));
    expect(eq(detail.transaction.amount, '100')).toBe(true);
    expect(detail.ledgerEntries).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('103');
  });

  it('activity feed: paid amount for deposits, total for loads, net for money out — no balance', async () => {
    const page = backofficeList(
      await activity.list({
        query: { page: 1, pageSize: 50, companyId: co.companyId },
        backoffice: true,
      }),
      backofficeActivityItem,
    );
    // One company + one currency + no filter would be balance mode for an
    // admin; back office never gets it (nor pays for its queries).
    expect(page.meta.balanceMode).toBe(false);
    const byId = new Map(page.data.map((r) => [r.id, r]));
    expect(eq(byId.get(onTopDepositId)!.amount, '100')).toBe(true);
    expect(eq(byId.get(deductedDepositId)!.amount, '200')).toBe(true);
    expect(eq(byId.get(loadId)!.amount, '103')).toBe(true);
    expect(eq(byId.get(withdrawalId)!.amount, '50')).toBe(true);
    expect(eq(byId.get(payoutId)!.amount, '8.50')).toBe(true);
    for (const row of page.data) {
      expect(Object.keys(row)).not.toContain('fee');
      expect(Object.keys(row)).not.toContain('networkFee');
      expect(Object.keys(row)).not.toContain('net');
      expect(row.balanceAfter).toBeNull();
    }

    // The same feed for a full admin still shows the gross that moved.
    const admin = await activity.list({
      query: { page: 1, pageSize: 50, companyId: co.companyId, kind: ActivityKind.DEPOSIT },
    });
    const adminOnTop = admin.data.find((r) => r.id === onTopDepositId)!;
    expect(eq(adminOnTop.amount, '103')).toBe(true);
    expect(eq(adminOnTop.fee, '2')).toBe(true);
    expect(eq(adminOnTop.networkFee, '1')).toBe(true);
  });

  it('flow rows: only the pay / collect figure', async () => {
    const w = backofficePayOut(await h.withdrawals.getById(withdrawalId));
    expect(eq(w.netAmount, '50')).toBe(true);
    expect(JSON.stringify(w)).not.toMatch(/"(amount|feeAmount|networkFeeAmount|totalAmount)"/);
    const p = backofficePayOut(await h.payouts.getById(payoutId));
    expect(eq(p.netAmount, '8.50')).toBe(true);
    const l = backofficeLoad(await h.loads.getById(loadId));
    expect(eq(l.totalAmount, '103')).toBe(true);
    expect(JSON.stringify(l)).not.toMatch(/"(amount|feeAmount|networkFeeAmount|netAmount)"/);
  });

  it('CSV exports: one money column per row, every fee column blank', async () => {
    const col = (rows: string[][], name: string) => rows[0]!.indexOf(name);

    const deposits = await readCsv(
      h.transactions.streamCsv({ query: { companyId: co.companyId } as never, backoffice: true }),
    );
    const onTopRow = deposits.find((r) => r[0] === onTopDepositId)!;
    expect(eq(onTopRow[col(deposits, 'amount')], '100')).toBe(true);
    for (const hidden of ['commission_amount', 'net_amount', 'network_fee_amount']) {
      expect(onTopRow[col(deposits, hidden)]).toBe('');
    }
    expect(onTopRow.join(',')).not.toContain('103');

    const feed = await readCsv(
      activity.streamCsv({
        query: { page: 1, pageSize: 20, companyId: co.companyId },
        backoffice: true,
      }),
    );
    const cell = (id: string, name: string) => feed.find((r) => r[0] === id)![col(feed, name)];
    // Money in: gross_amount only (the paid amount / the collected total).
    expect(eq(cell(onTopDepositId, 'gross_amount'), '100')).toBe(true);
    expect(eq(cell(deductedDepositId, 'gross_amount'), '200')).toBe(true);
    expect(eq(cell(loadId, 'gross_amount'), '103')).toBe(true);
    expect(cell(onTopDepositId, 'net_amount')).toBe('');
    expect(cell(loadId, 'net_amount')).toBe('');
    // Money out: net_amount only.
    expect(eq(cell(withdrawalId, 'net_amount'), '50')).toBe(true);
    expect(eq(cell(payoutId, 'net_amount'), '8.50')).toBe(true);
    expect(cell(withdrawalId, 'gross_amount')).toBe('');
    for (const id of [onTopDepositId, deductedDepositId, loadId, withdrawalId, payoutId]) {
      for (const hidden of ['fee_amount', 'network_fee_amount', 'fee_application']) {
        expect(cell(id, hidden)).toBe('');
      }
    }
  });
});

describe('admin rollups show the network fee beside every volume that includes it', () => {
  it('by source, by company-in-source, per day, and the pending-load total', async () => {
    const analytics = new AnalyticsService(h.prisma, passThroughCache, h.ledger);
    const platform = new PlatformAnalyticsService(h.prisma, passThroughCache);

    const co = await createCompany(h);
    const sourceId = await createEnabledSource(h, co.companyId);
    await addFixedFlowFee(h, co.companyId, 'TRANSACTION', '2');
    await addFixedFlowFee(h, co.companyId, 'LOAD', '2', 'ON_TOP');
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'LOAD', feeType: 'PERCENTAGE', feeValue: '1' },
      ],
    });
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(co.companyId, '100'));
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(co.companyId, '300'));

    // Company drill-down → By source: volume 400, commission 4, network fee 4.
    const overview = await analytics.overview({
      scope: 'admin',
      range: { companyId: co.companyId, currency: USD },
    });
    const src = overview.topSources.find((s) => s.sourceId === sourceId)!;
    expect(eq(src.volume, '400')).toBe(true);
    expect(eq(src.fees, '4')).toBe(true);
    expect(eq(src.networkFees, '4')).toBe(true);
    // Per bucket: the day's figures add up to the same totals.
    const sum = (pick: (b: (typeof overview.daily.buckets)[number]) => string) =>
      overview.daily.buckets.reduce((s, b) => s.add(Money.of(pick(b))), Money.zero()).toString();
    expect(
      eq(
        sum((b) => b.fees),
        '4',
      ),
    ).toBe(true);
    expect(
      eq(
        sum((b) => b.networkFees),
        '4',
      ),
    ).toBe(true);
    expect(
      eq(
        sum((b) => b.volume),
        '400',
      ),
    ).toBe(true);
    // The KPI and the by-source rows agree, account by account.
    expect(eq(overview.kpi.totalFees, '4')).toBe(true);
    expect(eq(overview.kpi.totalNetworkFees, '4')).toBe(true);

    // Source drill-down → By company.
    const source = await analytics.sourceOverview({ sourceId, range: { currency: USD } });
    const mine = source.byCompany.find((c) => c.companyId === co.companyId)!;
    expect(eq(mine.volume, '400')).toBe(true);
    expect(eq(mine.fees, '4')).toBe(true);
    expect(eq(mine.networkFees, '4')).toBe(true);
    expect(eq(source.kpi.totalNetworkFees, '4')).toBe(true);

    // Admin overview → By source (carried on the flows endpoint).
    const flows = await platform.flows({ currency: USD });
    const top = flows.topSources.find((s) => s.sourceId === sourceId);
    if (top) {
      // (Only the top few sources are listed; when ours is among them it must
      // carry both fees.)
      expect(eq(top.fees, '4')).toBe(true);
      expect(eq(top.networkFees, '4')).toBe(true);
    }

    // Operations queue: a pending ON_TOP load shows the total to collect (103),
    // the figure the Loads page and the "new request" notification show.
    const load = await h.loads.request(co.companyId, co.userId, loadInput('100'));
    expect(eq(load.totalAmount, '103')).toBe(true);
    const ops = await platform.operations();
    const item = ops.items.find((i) => i.id === load.id)!;
    expect(item.kind).toBe('load_pending');
    expect(eq(item.amount, '103')).toBe(true);
    expect(item.summary).toContain('103');
  });

  it('the all-time platform rollup includes both revenue accounts (and uses its index)', async () => {
    const platform = new PlatformAnalyticsService(h.prisma, passThroughCache);
    const all = await platform.platform({ preset: 'all' });
    const usd = all.byCurrency.find((c) => c.currency === USD)!;
    expect(
      Money.of(usd.netRevenue).eq(
        Money.of(usd.feesEarned).add(Money.of(usd.networkFeesEarned)).sub(Money.of(usd.sourceFees)),
      ),
    ).toBe(true);
    expect(Money.of(usd.networkFeesEarned).isPositive()).toBe(true);

    // The NETWORK_FEE partial index exists and is the planner's choice for the
    // network-fee revenue sum (a literal account, as ledger-revenue.ts writes it).
    const idx = await h.prisma.runAsAdmin((tx) =>
      tx.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'ledger_entries_network_fee_currency_created_idx'`,
      ),
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain(`WHERE (account_type = 'NETWORK_FEE'`);
    const plan = await h.prisma.runAsAdmin(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT currency, SUM(amount) FROM ledger_entries
         WHERE account_type = 'NETWORK_FEE' AND created_at >= now() - interval '1 day'
         GROUP BY currency`,
      );
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'ledger_entries_network_fee_currency_created_idx',
    );
  });
});
