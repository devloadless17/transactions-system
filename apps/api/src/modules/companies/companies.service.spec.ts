import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@app/shared';
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
  // Totals: a genuine cross-company aggregate.
  const groupBy = vi.fn(() =>
    Promise.resolve(
      opts.currencyTotals.map((t) => ({
        currency: t.currency,
        _sum: { availableBalance: dec(t.sum) },
      })),
    ),
  );
  // Per-page balances: a plain read — `wallets` is unique on (companyId, currency),
  // so there is nothing to aggregate.
  type FindManyArgs = { where: { companyId: { in: string[] } } };
  const walletFindMany = vi.fn((_args: FindManyArgs) =>
    Promise.resolve(
      opts.pageWallets.map((w) => ({
        companyId: w.companyId,
        currency: w.currency,
        availableBalance: dec(w.sum),
      })),
    ),
  );

  const tx = {
    company: {
      findMany: vi.fn().mockResolvedValue(opts.companies),
      count: vi.fn().mockResolvedValue(opts.total),
    },
    wallet: { groupBy, findMany: walletFindMany },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const realtime = { admin: vi.fn() } as unknown as RealtimeService;

  return { svc: new CompaniesService(prisma, realtime), groupBy, walletFindMany, tx };
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
    const { svc, groupBy, walletFindMany } = makeService({
      companies: [COMPANY('c1', 'A'), COMPANY('c2', 'B')],
      total: 2,
      pageWallets: [{ companyId: 'c1', currency: 'USD', sum: '10' }],
      currencyTotals: [{ currency: 'USD', sum: '10' }],
    });

    await svc.list(query, AS_SUPER_ADMIN);
    // One aggregate for the cross-company totals…
    expect(groupBy).toHaveBeenCalledTimes(1);
    // …and one plain batched read for the page (never one per row).
    expect(walletFindMany).toHaveBeenCalledTimes(1);
    expect(walletFindMany.mock.calls[0][0].where.companyId.in).toEqual(['c1', 'c2']);
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

  it('skips the per-page wallet read entirely when the page is empty', async () => {
    const { svc, groupBy, walletFindMany } = makeService({
      companies: [],
      total: 0,
      pageWallets: [],
      currencyTotals: [],
    });

    const res = await svc.list(query, AS_SUPER_ADMIN);
    expect(res.data).toEqual([]);
    expect(res.totals).toEqual([]);
    // Only the totals aggregate ran; no pointless `companyId IN ()` query.
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(walletFindMany).not.toHaveBeenCalled();
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
    const { svc, groupBy, walletFindMany } = makeService(seeded);
    await svc.list(query, { includeBalances: false });
    expect(groupBy).not.toHaveBeenCalled();
    expect(walletFindMany).not.toHaveBeenCalled();
  });

  it('defaults to WITHHOLDING balances when the caller is unspecified (fail closed)', async () => {
    const { svc, groupBy, walletFindMany } = makeService(seeded);
    const res = await svc.list(query);
    expect(res.totals).toBeUndefined();
    expect(groupBy).not.toHaveBeenCalled();
    expect(walletFindMany).not.toHaveBeenCalled();
  });

  it('still returns the company rows themselves', async () => {
    const { svc } = makeService(seeded);
    const res = await svc.list(query, { includeBalances: false });
    expect(res.data.map((c) => c.name)).toEqual(['Alpha', 'Beta']);
    expect(res.meta.total).toBe(2);
  });
});

/**
 * Shared by the slug-rename, rename and audit-diff suites below: a CompaniesService
 * wired to an in-memory tx, so update()'s gates and diff can be asserted without a DB.
 */
function makeUpdateService(opts: {
  existing: ReturnType<typeof COMPANY>;
  slugTakenBy?: ReturnType<typeof COMPANY>;
  retiredBy?: string; // companyId that once held the requested slug
}) {
  const findUnique = vi.fn((args: { where: { id?: string; slug?: string } }) => {
    if (args.where.id) return Promise.resolve(opts.existing);
    if (args.where.slug) return Promise.resolve(opts.slugTakenBy ?? null);
    return Promise.resolve(null);
  });
  const update = vi.fn((args: { where: { id: string }; data: Record<string, unknown> }) =>
    Promise.resolve({ ...opts.existing, ...args.data }),
  );
  const historyFindUnique = vi.fn((args: { where: { slug: string } }) =>
    Promise.resolve(opts.retiredBy ? { slug: args.where.slug, companyId: opts.retiredBy } : null),
  );
  const historyUpsert = vi.fn(() => Promise.resolve({}));
  const tx = {
    company: { findUnique, update },
    companySlugHistory: { findUnique: historyFindUnique, upsert: historyUpsert },
  };
  const prisma = {
    runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  const realtime = { admin: vi.fn() } as unknown as RealtimeService;
  return { svc: new CompaniesService(prisma, realtime), findUnique, update, historyUpsert };
}

/**
 * Slug rename contract: the slug is the PUBLIC identifier external sources
 * ingest with, so update() must (a) allow renaming it, (b) 409 on a collision
 * with another company, and (c) not run the collision check when the slug is
 * untouched.
 */
describe('CompaniesService.update — slug rename', () => {
  const SUPER = { actorRole: UserRole.SUPER_ADMIN };

  it('renames the slug when the new slug is free, tombstoning the old one', async () => {
    const { svc, update, historyUpsert } = makeUpdateService({ existing: COMPANY('c1', 'Alpha') });
    const res = await svc.update('c1', { slug: 'alpha-renamed' }, SUPER);
    expect(res.slug).toBe('alpha-renamed');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: 'alpha-renamed' }) }),
    );
    // The renamed-AWAY slug is retired so no other company can ever claim it.
    expect(historyUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'alpha' } }),
    );
  });

  it('403s a slug change without an explicit SUPER_ADMIN actor (any caller of update())', async () => {
    const { svc, update } = makeUpdateService({ existing: COMPANY('c1', 'Alpha') });
    await expect(svc.update('c1', { slug: 'alpha-renamed' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
    await expect(
      svc.update('c1', { slug: 'alpha-renamed' }, { actorRole: UserRole.ADMIN_OPERATOR }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });

  it('409s when the new slug already belongs to another company', async () => {
    const { svc, update } = makeUpdateService({
      existing: COMPANY('c1', 'Alpha'),
      slugTakenBy: COMPANY('c2', 'Beta'),
    });
    await expect(svc.update('c1', { slug: 'beta' }, SUPER)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("409s when the new slug is another company's RETIRED slug (tombstone)", async () => {
    const { svc, update } = makeUpdateService({
      existing: COMPANY('c1', 'Alpha'),
      retiredBy: 'c2',
    });
    await expect(svc.update('c1', { slug: 'beta-old' }, SUPER)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('allows a company to reclaim its OWN retired slug', async () => {
    const { svc } = makeUpdateService({
      existing: COMPANY('c1', 'Alpha'),
      retiredBy: 'c1',
    });
    const res = await svc.update('c1', { slug: 'alpha-old' }, SUPER);
    expect(res.slug).toBe('alpha-old');
  });

  it('skips slug gating entirely when the slug is unchanged (operators can PATCH other fields)', async () => {
    const existing = COMPANY('c1', 'Alpha');
    const { svc, findUnique } = makeUpdateService({ existing });
    // `visible` (not `name`, which is privileged in its own right now) — the
    // subject here is that an unchanged slug runs no collision check.
    await svc.update('c1', { slug: existing.slug, visible: false });
    // Only the by-id lookup ran — no by-slug query, and no Forbidden despite
    // the missing actorRole, because nothing privileged was changed.
    expect(findUnique.mock.calls.filter(([a]) => 'slug' in a.where)).toHaveLength(0);
  });
});

/**
 * Rename contract. The display name breaks nothing downstream (sources ingest
 * by SLUG, it isn't unique, nothing keys on it) but it relabels the tenant
 * everywhere an admin looks, so it carries the same SUPER_ADMIN gate the slug
 * does — and, like the slug's, that gate is per-FIELD so operators keep their
 * status/visibility PATCHes.
 */
describe('CompaniesService.update — rename', () => {
  const SUPER = { actorRole: UserRole.SUPER_ADMIN };

  it('renames when the actor is SUPER_ADMIN', async () => {
    const { svc, update } = makeUpdateService({ existing: COMPANY('c1', 'Alpha') });
    const res = await svc.update('c1', { name: 'Alpha Renamed' }, SUPER);
    expect(res.name).toBe('Alpha Renamed');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Alpha Renamed' }) }),
    );
  });

  it('403s a rename without an explicit SUPER_ADMIN actor, and does not write', async () => {
    const { svc, update } = makeUpdateService({ existing: COMPANY('c1', 'Alpha') });
    await expect(svc.update('c1', { name: 'Alpha Renamed' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
    await expect(
      svc.update('c1', { name: 'Alpha Renamed' }, { actorRole: UserRole.ADMIN_OPERATOR }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });

  // An operator PATCHing visibility from a form that echoes the current name
  // must not 403 — the gate keys on an actual CHANGE, like the slug's does.
  it('treats an unchanged name as unprivileged', async () => {
    const existing = COMPANY('c1', 'Alpha');
    const { svc, update } = makeUpdateService({ existing });
    await expect(svc.update('c1', { name: existing.name, visible: false })).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });
});

/**
 * Audit diffs. The interceptor can only see the request body and the result, so
 * update() hands it the before→after diff — and must do so only for fields that
 * actually changed, only from the allowlist, and only once the write committed.
 */
describe('CompaniesService.update — audit diff', () => {
  const SUPER = { actorRole: UserRole.SUPER_ADMIN };

  it('publishes only the fields that actually changed', async () => {
    const existing = COMPANY('c1', 'Alpha'); // visible: true
    const { svc } = makeUpdateService({ existing });
    const onChanges = vi.fn();
    await svc.update(
      'c1',
      { name: 'Alpha Renamed', visible: existing.visible },
      {
        ...SUPER,
        onChanges,
      },
    );
    expect(onChanges).toHaveBeenCalledWith({
      name: { from: 'Alpha', to: 'Alpha Renamed' },
    });
  });

  it('publishes nothing when the PATCH is a no-op', async () => {
    const existing = COMPANY('c1', 'Alpha');
    const { svc } = makeUpdateService({ existing });
    const onChanges = vi.fn();
    await svc.update('c1', { name: existing.name }, { ...SUPER, onChanges });
    expect(onChanges).not.toHaveBeenCalled();
  });

  // The write runs in an interactive transaction, so a diff emitted before the
  // commit could describe a change that rolled back.
  it('does not publish a diff when the write fails', async () => {
    const { svc, update } = makeUpdateService({ existing: COMPANY('c1', 'Alpha') });
    update.mockRejectedValueOnce(new Error('db down'));
    const onChanges = vi.fn();
    await expect(
      svc.update('c1', { name: 'Alpha Renamed' }, { ...SUPER, onChanges }),
    ).rejects.toThrow('db down');
    expect(onChanges).not.toHaveBeenCalled();
  });

  // Security regression guard: `companies` carries webhookSecret / crmApiKey /
  // crmDemoToken on the same row, and audit logs are ADMIN_OPERATOR-readable.
  it('never diffs a field outside the allowlist', async () => {
    const existing = COMPANY('c1', 'Alpha');
    const { svc } = makeUpdateService({ existing });
    const onChanges = vi.fn();
    await svc.update('c1', { name: 'Alpha Renamed', webhookSecret: 'leaked' } as never, {
      ...SUPER,
      onChanges,
    });
    const [changes] = onChanges.mock.calls[0];
    expect(Object.keys(changes)).toEqual(['name']);
  });
});

/**
 * The network-fee configuration write (SUPER_ADMIN, enforced on the route):
 * one transaction that locks the company row, flips the switch and replaces the
 * rates; the audit diff is published only after it commits.
 */
describe('CompaniesService.setNetworkFee', () => {
  function makeNetworkFeeService(opts: {
    locked?: boolean;
    enabled?: boolean;
    rates?: Array<{ operationType: string; feeType: string; feeValue: string }>;
  }) {
    let stored = (opts.rates ?? []).map((r) => ({ ...r, feeValue: dec(r.feeValue) }));
    const calls: string[] = [];
    const queryRaw = vi.fn(() => {
      calls.push('lock');
      return Promise.resolve(opts.locked === false ? [] : [{ id: 'c1' }]);
    });
    const findUniqueOrThrow = vi.fn(() =>
      Promise.resolve({ networkFeeEnabled: opts.enabled ?? false, networkFees: stored }),
    );
    const update = vi.fn(() => {
      calls.push('switch');
      return Promise.resolve({});
    });
    const deleteMany = vi.fn(() => {
      calls.push('delete');
      stored = [];
      return Promise.resolve({ count: 0 });
    });
    const createMany = vi.fn(
      (args: { data: Array<{ operationType: string; feeType: string; feeValue: string }> }) => {
        calls.push('insert');
        stored = args.data.map((r) => ({ ...r, feeValue: dec(r.feeValue) }));
        return Promise.resolve({ count: args.data.length });
      },
    );
    const findMany = vi.fn(() => Promise.resolve(stored));
    const tx = {
      $queryRaw: queryRaw,
      company: { findUniqueOrThrow, update },
      companyNetworkFee: { deleteMany, createMany, findMany },
    };
    const prisma = {
      runAsAdmin: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const realtime = { admin: vi.fn() } as unknown as RealtimeService;
    return {
      svc: new CompaniesService(prisma, realtime),
      prisma,
      realtime,
      calls,
      update,
      createMany,
    };
  }

  it('locks the row, flips the switch and replaces the rates — in ONE transaction, in that order', async () => {
    const { svc, prisma, calls, update } = makeNetworkFeeService({});
    const res = await svc.setNetworkFee('c1', {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    expect(prisma.runAsAdmin).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['lock', 'switch', 'delete', 'insert']);
    expect(update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { networkFeeEnabled: true } });
    expect(res).toEqual({
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
  });

  it('switching off with no rates deletes them and inserts nothing', async () => {
    const { svc, calls, createMany } = makeNetworkFeeService({
      enabled: true,
      rates: [{ operationType: 'LOAD', feeType: 'FIXED', feeValue: '2' }],
    });
    const res = await svc.setNetworkFee('c1', { enabled: false, rates: [] });
    expect(createMany).not.toHaveBeenCalled();
    expect(calls).toEqual(['lock', 'switch', 'delete']);
    expect(res).toEqual({ enabled: false, rates: [] });
  });

  it('404s an unknown company and writes nothing', async () => {
    const { svc, calls } = makeNetworkFeeService({ locked: false });
    await expect(svc.setNetworkFee('nope', { enabled: false, rates: [] })).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(calls).toEqual(['lock']);
  });

  it('publishes the audit diff after the commit, and refreshes the admin views', async () => {
    const { svc, realtime } = makeNetworkFeeService({
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2' }],
    });
    const onChanges = vi.fn();
    await svc.setNetworkFee(
      'c1',
      {
        enabled: true,
        rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '3' }],
      },
      { onChanges },
    );
    expect(onChanges).toHaveBeenCalledWith({
      'networkFee.WITHDRAWAL': { from: 'FIXED 2', to: 'FIXED 3' },
    });
    expect(realtime.admin).toHaveBeenCalledWith(['companies'], 'c1');
  });

  it('an identical save publishes no diff', async () => {
    const { svc } = makeNetworkFeeService({
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2' }],
    });
    const onChanges = vi.fn();
    await svc.setNetworkFee(
      'c1',
      {
        enabled: true,
        rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2.00' }],
      },
      { onChanges },
    );
    expect(onChanges).not.toHaveBeenCalled();
  });
});
