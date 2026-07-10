import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { CompaniesService } from './companies.service';

/**
 * Pins the balance/total contract of the admin companies list:
 *  - each row carries its available balance per currency,
 *  - `totals` sums EVERY matching company (not just the current page),
 *  - balances are fetched in ONE batched query (no N+1).
 */

// Prisma returns Decimal; only `.toString()` is used by the service.
const dec = (s: string) => ({ toString: () => s });

const COMPANY = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  status: 'ACTIVE',
  visible: true,
  defaultCurrency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
});

function makeService(opts: {
  companies: ReturnType<typeof COMPANY>[];
  total: number;
  pageWallets: Array<{ companyId: string; currency: string; sum: string }>;
  currencyTotals: Array<{ currency: string; sum: string }>;
}) {
  type GroupByArgs = { by: string[]; where?: { companyId?: { in: string[] } } };

  const groupBy = vi.fn(({ by }: GroupByArgs) => {
    if (by.includes('companyId')) {
      return Promise.resolve(
        opts.pageWallets.map((w) => ({
          companyId: w.companyId,
          currency: w.currency,
          _sum: { availableBalance: dec(w.sum) },
        })),
      );
    }
    return Promise.resolve(
      opts.currencyTotals.map((t) => ({
        currency: t.currency,
        _sum: { availableBalance: dec(t.sum) },
      })),
    );
  });

  const tx = {
    company: {
      findMany: vi.fn().mockResolvedValue(opts.companies),
      count: vi.fn().mockResolvedValue(opts.total),
    },
    wallet: { groupBy },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const realtime = { admin: vi.fn() } as unknown as RealtimeService;

  return { svc: new CompaniesService(prisma, realtime), groupBy, tx };
}

const query = { page: 1, pageSize: 2 } as never;
const AS_SUPER_ADMIN = { includeBalances: true };

describe('CompaniesService.list — balances & totals', () => {
  it('attaches each company its available balance per currency', async () => {
    const { svc } = makeService({
      companies: [COMPANY('c1', 'Alpha'), COMPANY('c2', 'Beta')],
      total: 5,
      pageWallets: [
        { companyId: 'c1', currency: 'USD', sum: '1255' },
        { companyId: 'c2', currency: 'USD', sum: '875' },
      ],
      currencyTotals: [{ currency: 'USD', sum: '3882' }],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    expect(res.data[0].balances).toEqual([{ currency: 'USD', availableBalance: '1255' }]);
    expect(res.data[1].balances).toEqual([{ currency: 'USD', availableBalance: '875' }]);
  });

  it('totals cover ALL matching companies, not just the page', async () => {
    const { svc } = makeService({
      companies: [COMPANY('c1', 'Alpha'), COMPANY('c2', 'Beta')],
      total: 5,
      pageWallets: [
        { companyId: 'c1', currency: 'USD', sum: '1255' },
        { companyId: 'c2', currency: 'USD', sum: '875' },
      ],
      currencyTotals: [{ currency: 'USD', sum: '3882' }],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    const pageSum = res.data.reduce(
      (n, c) => n + Number(c.balances?.[0]?.availableBalance ?? 0),
      0,
    );
    expect(pageSum).toBe(2130); // this page only
    expect(res.totals).toEqual([{ currency: 'USD', availableBalance: '3882' }]); // every company
    expect(res.meta.total).toBe(5);
  });

  it('fetches balances in ONE batched query per concern (no N+1)', async () => {
    const { svc, groupBy } = makeService({
      companies: [COMPANY('c1', 'A'), COMPANY('c2', 'B')],
      total: 2,
      pageWallets: [{ companyId: 'c1', currency: 'USD', sum: '10' }],
      currencyTotals: [{ currency: 'USD', sum: '10' }],
    });

    await svc.list(query, AS_SUPER_ADMIN);
    // Exactly two: one grouped by currency (totals), one by companyId (the page).
    expect(groupBy).toHaveBeenCalledTimes(2);
    const pageCall = groupBy.mock.calls.find((c) => c[0].by.includes('companyId'))?.[0];
    expect(pageCall?.where?.companyId?.in).toEqual(['c1', 'c2']);
  });

  it('a company with no wallet reports an empty list, not a fake zero', async () => {
    const { svc } = makeService({
      companies: [COMPANY('c1', 'Alpha'), COMPANY('c2', 'NoWallet')],
      total: 2,
      pageWallets: [{ companyId: 'c1', currency: 'USD', sum: '5' }],
      currencyTotals: [{ currency: 'USD', sum: '5' }],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    expect(res.data[1].balances).toEqual([]);
  });

  it('skips the wallet lookup entirely when the page is empty', async () => {
    const { svc, groupBy } = makeService({
      companies: [],
      total: 0,
      pageWallets: [],
      currencyTotals: [],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    expect(res.data).toEqual([]);
    expect(res.totals).toEqual([]);
    // Only the totals groupBy ran; no pointless `companyId IN ()` query.
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('keeps multiple currencies separate and sorted (future-proofing)', async () => {
    const { svc } = makeService({
      companies: [COMPANY('c1', 'Alpha')],
      total: 1,
      pageWallets: [
        { companyId: 'c1', currency: 'USD', sum: '100' },
        { companyId: 'c1', currency: 'EUR', sum: '50' },
      ],
      currencyTotals: [
        { currency: 'USD', sum: '100' },
        { currency: 'EUR', sum: '50' },
      ],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    expect(res.data[0].balances).toEqual([
      { currency: 'EUR', availableBalance: '50' },
      { currency: 'USD', availableBalance: '100' },
    ]);
    expect(res.totals?.map((t) => t.currency)).toEqual(['EUR', 'USD']);
  });
});

/**
 * Balances are an AUTHORIZATION boundary, not a UI toggle: ADMIN_OPERATOR and
 * BACKOFFICE may see that a tenant exists, never how much money it holds. The
 * figures must not reach the response at all — hiding a column would still ship
 * them over the wire.
 */
describe('CompaniesService.list — balances are SUPER_ADMIN-only', () => {
  const seeded = {
    companies: [COMPANY('c1', 'Alpha'), COMPANY('c2', 'Beta')],
    total: 2,
    pageWallets: [
      { companyId: 'c1', currency: 'USD', sum: '1255' },
      { companyId: 'c2', currency: 'USD', sum: '875' },
    ],
    currencyTotals: [{ currency: 'USD', sum: '3882' }],
  };

  it('omits balances and totals when the caller may not see them', async () => {
    const { svc } = makeService(seeded);
    const res = await svc.list(query, { includeBalances: false });

    expect(res.totals).toBeUndefined();
    for (const c of res.data) expect(c.balances).toBeUndefined();
  });

  it('never even queries the wallets table when not permitted (no leak, no cost)', async () => {
    const { svc, groupBy } = makeService(seeded);
    await svc.list(query, { includeBalances: false });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('defaults to WITHHOLDING balances when the caller is unspecified (fail closed)', async () => {
    const { svc, groupBy } = makeService(seeded);
    const res = await svc.list(query);
    expect(res.totals).toBeUndefined();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('still returns the company rows themselves', async () => {
    const { svc } = makeService(seeded);
    const res = await svc.list(query, { includeBalances: false });
    expect(res.data.map((c) => c.name)).toEqual(['Alpha', 'Beta']);
    expect(res.meta.total).toBe(2);
  });
});
