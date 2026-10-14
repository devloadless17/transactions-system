/**
 * Search finds a row by whatever a person quotes — against real Postgres + RLS.
 *
 * Oct 2026: searching a customer's phone in the activity feed showed their
 * deposits but not the withdrawal paid to that same phone. The feed searched
 * one "details" field per row (the first of name / account / wallet…), so a
 * withdrawal's recipient phone was never looked at; the withdrawals, payouts
 * and loads lists had no search at all; deposits matched only the reference.
 * One rule now (common/search.ts) for all of them, their counts and exports.
 *
 * The test DB is shared by every spec file, so every value here is unique to
 * this run (a fresh phone number, names and references).
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateWithdrawalInput } from '@app/shared';
import { ActivityService } from '../../src/modules/activity/activity.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import {
  addFlowFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  type Harness,
} from './harness';

const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

// A fresh Lebanese mobile number, as a person might quote it in any format.
const local = `70${randomInt(100_000, 999_999)}`; // 70xxxxxx
const intl = `+961${local}`;
const spaced = `+961 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
const tag = `${randomInt(1e9, 9e9)}`;
const recipient = `Hamza Srch${tag}`;

let h: Harness;
let activity: ActivityService;
let co: { companyId: string; userId: string };
let other: { companyId: string; userId: string };
let completedWithdrawal: string;
let pendingWithdrawal: string;
let payoutId: string;
let loadId: string;
let depositId: string;
let otherDepositId: string;

const wish = (amount: string, phone = intl, notes?: string): CreateWithdrawalInput => ({
  amount,
  currency: 'USD',
  ...(notes ? { notes } : {}),
  payout: { method: 'WISH', recipientName: recipient, recipientPhone: phone },
});
const cash = (amount: string) => ({
  amount,
  currency: 'USD' as const,
  payout: {
    method: 'CASH' as const,
    recipientName: recipient,
    recipientPhone: intl,
    pickupLocation: 'Main branch',
  },
});

async function fund(companyId: string): Promise<string> {
  const sourceId = await createEnabledSource(h, companyId);
  await addFlowFee(h, companyId, 'TRANSACTION', '0');
  const tx = await h.transactions.ingest(
    { kind: 'source', sourceId },
    ingestInput(companyId, '1000', {
      externalTransactionId: `dep-${tag}-${companyId.slice(0, 4)}`,
      payload: { customer: `Customer ${tag}`, phone: `961${local}`, note: `order ${tag}` },
    }),
  );
  return tx.id;
}

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  activity = new ActivityService(h.prisma, passThroughCache);

  co = await createCompany(h);
  depositId = await fund(co.companyId);
  const w = await h.withdrawals.request(co.companyId, co.userId, wish('50', intl, `ticket ${tag}`));
  await h.withdrawals.approve(w.id, co.userId, { externalReference: `wt_${tag}` });
  completedWithdrawal = w.id;
  pendingWithdrawal = (await h.withdrawals.request(co.companyId, co.userId, wish('20'))).id;
  payoutId = (await h.payouts.request(co.companyId, co.userId, cash('30'))).id;
  loadId = (await h.loads.request(co.companyId, co.userId, cash('40'))).id;

  // Rows of the same company for someone else: a list that ignored the search
  // would return these too.
  const elsewhere = {
    recipientName: 'Someone Else',
    recipientPhone: '+96171000000',
  };
  await h.withdrawals.request(co.companyId, co.userId, {
    amount: '5',
    currency: 'USD',
    payout: { method: 'WISH', ...elsewhere },
  });
  await h.payouts.request(co.companyId, co.userId, {
    ...cash('5'),
    payout: { ...cash('5').payout, ...elsewhere, pickupLocation: 'North branch' },
  });
  await h.loads.request(co.companyId, co.userId, {
    ...cash('5'),
    payout: { ...cash('5').payout, ...elsewhere, pickupLocation: 'North branch' },
  });

  // Another company paying the SAME phone: must never show up in co's results.
  other = await createCompany(h);
  otherDepositId = await fund(other.companyId);
  await h.withdrawals.request(other.companyId, other.userId, wish('10'));
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

const page = { page: 1, pageSize: 50 };
const ids = (r: { data: Array<{ id: string }> }) => r.data.map((x) => x.id).sort();

describe('activity feed (completed money)', () => {
  it('finds the withdrawal paid to a phone — however the phone is typed (the bug)', async () => {
    for (const typed of [local, intl, spaced, `00961${local}`, `961-${local}`]) {
      const r = await activity.list({ companyId: co.companyId, query: { ...page, search: typed } });
      // The deposit from that payer AND the withdrawal to that recipient.
      expect(ids(r), typed).toEqual([completedWithdrawal, depositId].sort());
      expect(r.meta.total, typed).toBe(2);
    }
  });

  it('by recipient name (any case), reference, note, or id prefix', async () => {
    for (const typed of [
      recipient.toLowerCase(),
      `wt_${tag}`,
      `ticket ${tag}`,
      completedWithdrawal.slice(0, 8),
    ]) {
      const r = await activity.list({ companyId: co.companyId, query: { ...page, search: typed } });
      expect(ids(r), typed).toContain(completedWithdrawal);
    }
  });

  it('the admin feed finds both companies; a company only ever its own', async () => {
    const admin = await activity.list({ query: { ...page, search: local } });
    expect(admin.data.map((x) => x.companyId)).toEqual(
      expect.arrayContaining([co.companyId, other.companyId]),
    );
    // RLS: the other company sees its own deposit from that payer — none of
    // co's rows (its own withdrawal to that phone is still pending).
    const own = await activity.list({
      companyId: other.companyId,
      query: { ...page, search: local },
    });
    expect(ids(own)).toEqual([otherDepositId]);
  });

  it('the CSV export holds exactly the searched rows', async () => {
    let csv = '';
    for await (const chunk of activity
      .streamCsv({ companyId: co.companyId, query: { ...page, search: intl } })
      .getStream()) {
      csv += chunk;
    }
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + deposit + withdrawal
    expect(csv).toContain(completedWithdrawal);
    expect(csv).toContain(depositId);
  });
});

describe('withdrawals / payouts / loads lists (every status)', () => {
  it('withdrawals: completed AND pending found by the phone, any format', async () => {
    for (const typed of [local, spaced, `00961${local}`]) {
      const r = await h.withdrawals.list({
        companyId: co.companyId,
        query: { ...page, search: typed },
      });
      expect(ids(r), typed).toEqual([completedWithdrawal, pendingWithdrawal].sort());
      expect(r.meta.total, typed).toBe(2);
    }
  });

  it('withdrawals: search combines with the other filters', async () => {
    const r = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: recipient.toUpperCase(), status: 'PENDING' },
    });
    expect(ids(r)).toEqual([pendingWithdrawal]);
  });

  it('payouts and loads: by the recipient phone, name, or pickup location', async () => {
    expect(
      ids(await h.payouts.list({ companyId: co.companyId, query: { ...page, search: local } })),
    ).toEqual([payoutId]);
    expect(
      ids(await h.loads.list({ companyId: co.companyId, query: { ...page, search: recipient } })),
    ).toEqual([loadId]);
    expect(
      ids(
        await h.payouts.list({
          companyId: co.companyId,
          query: { ...page, search: 'main branch' },
        }),
      ),
    ).toContain(payoutId);
  });

  it('an admin may narrow the search to one company; a company is held to its own rows', async () => {
    const admin = await h.withdrawals.list({ query: { ...page, search: local } });
    expect(admin.meta.total).toBe(3); // co: 2, other: 1
    const narrowed = await h.withdrawals.list({
      query: { ...page, search: local, companyId: other.companyId },
    });
    expect(narrowed.meta.total).toBe(1);
  });

  it('the withdrawals CSV export holds exactly the searched rows', async () => {
    const file = await h.withdrawals.streamCsv({
      companyId: co.companyId,
      query: { ...page, search: spaced },
    });
    let csv = '';
    for await (const chunk of file.getStream()) csv += chunk;
    expect(csv.trim().split('\n')).toHaveLength(3); // header + 2
  });

  it('LIKE wildcards are literal: "%" matches nothing here', async () => {
    const r = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: '%' },
    });
    expect(r.meta.total).toBe(0);
  });
});

describe('deposits list', () => {
  it('finds a deposit by the payer phone (any format), customer, note — and still by its reference', async () => {
    for (const typed of [local, spaced, `customer ${tag}`, `order ${tag}`, `dep-${tag}`]) {
      const r = await h.transactions.list({
        companyId: co.companyId,
        query: { ...page, search: typed },
      });
      expect(ids(r), typed).toEqual([depositId]);
    }
  });
});

describe('edge cases — whatever is typed, the search answers and never breaks', () => {
  it('Arabic names and accents match as typed', async () => {
    const arabic = `حمزة ${tag}`;
    const w = await h.withdrawals.request(co.companyId, co.userId, {
      amount: '3',
      currency: 'USD',
      payout: { method: 'WISH', recipientName: arabic, recipientPhone: '+96176000000' },
    });
    const r = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: 'حمزة' },
    });
    expect(ids(r)).toContain(w.id);
    const act = await activity.list({
      companyId: co.companyId,
      query: { ...page, search: 'حمزة' },
    });
    expect(act.meta.total).toBe(0); // pending — the feed shows completed money only
  });

  it('quotes, backslashes and SQL are just text: no error, no match', async () => {
    for (const typed of [`'; DROP TABLE withdrawals; --`, `" OR 1=1 --`, `\\`, `%%`, `)(`]) {
      const w = await h.withdrawals.list({
        companyId: co.companyId,
        query: { ...page, search: typed },
      });
      expect(w.meta.total, typed).toBe(0);
      const d = await h.transactions.list({
        companyId: co.companyId,
        query: { ...page, search: typed },
      });
      expect(d.meta.total, typed).toBe(0);
      const a = await activity.list({ companyId: co.companyId, query: { ...page, search: typed } });
      expect(a.meta.total, typed).toBe(0);
    }
    // `_` is literal too: it finds the one reference that contains it (`wt_…`),
    // not every row (an unescaped `_` matches any character).
    const underscore = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: '_' },
    });
    expect(ids(underscore)).toEqual([completedWithdrawal]);
    // …and the table is still there.
    expect(
      (await h.withdrawals.list({ companyId: co.companyId, query: page })).meta.total,
    ).toBeGreaterThan(0);
  });

  it('the longest allowed search (200 characters) answers', async () => {
    const long = `${local}${'x'.repeat(200 - local.length)}`;
    const r = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: long },
    });
    expect(r.meta.total).toBe(0);
  });

  it('an empty search is no filter at all', async () => {
    const all = await h.withdrawals.list({ companyId: co.companyId, query: page });
    const blank = await h.withdrawals.list({
      companyId: co.companyId,
      query: { ...page, search: '' },
    });
    expect(blank.meta.total).toBe(all.meta.total);
  });
});
