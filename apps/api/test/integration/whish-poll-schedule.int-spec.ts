/**
 * The Whish reconciliation poller follows a SCHEDULE (whish_payments.next_poll_at):
 * the links due now, earliest-due first, each next check paced by the link's
 * age. It is the backstop for Whish deposits — Whish only calls back on a
 * success, so a failed link reaches the company's CRM, and a success whose
 * callback was lost is booked, only when the poller asks Whish.
 *
 * Pinned here against the real database:
 *   - links Whish never resolves can no longer starve newer links (the poller
 *     used to take the oldest pending links every tick, and a link can stay
 *     pending for 24 hours);
 *   - paid-but-unsettled links (needsAttention) never take a slot;
 *   - each check schedules the next one by age, and an upstream error retries
 *     soon without holding the head of the queue;
 *   - rows written before the schedule existed (next_poll_at NULL) are polled
 *     exactly as before.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
import { WhishError } from '../../src/modules/whish/whish.client';
import { nextPollDelayMs } from '../../src/modules/whish/whish-payments.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  snapshot,
  USD,
  type Harness,
} from './harness';

let h: Harness;
let companyId: string;
let tok = 0;

const MIN = 60_000;

async function insertPending(
  ageMs: number,
  extra: { metadata?: object; nextPollAt?: Date } = {},
): Promise<{ id: string; externalId: string }> {
  const row = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: `it-poll-${Date.now().toString(36)}-${tok++}`,
        amount: '50.00',
        currency: USD,
        invoice: 'inv-poll',
        status: WhishPaymentStatus.PENDING,
        createdAt: new Date(Date.now() - ageMs),
        ...(extra.metadata ? { metadata: extra.metadata } : {}),
        ...(extra.nextPollAt ? { nextPollAt: extra.nextPollAt } : {}),
      },
      select: { id: true, externalId: true },
    }),
  );
  return { id: row.id, externalId: row.externalId.toString() };
}

const rowOf = (id: string) =>
  h.prisma.runAsAdmin((tx) => tx.whishPayment.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
});

beforeEach(async () => {
  // The integration database is shared by every spec file: park any pending
  // link the others left behind, so each test sees only its own.
  await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.updateMany({
      where: { status: WhishPaymentStatus.PENDING },
      data: { nextPollAt: new Date(Date.now() + 365 * 24 * 3600_000) },
    }),
  );
  ({ companyId } = await createCompany(h));
  await addTransactionFee(h, companyId, '0');
  h.whishClient.status = 'pending';
  h.whishClient.statusFor.clear();
  h.whishClient.getStatusCalls = [];
  h.whishClient.failGetStatusWith = null;
  h.crm.reset();
});

describe('nextPollDelayMs — the backstop slows down for links Whish never resolves', () => {
  it('checks a young link every minute, then every 5 minutes, then every 30', () => {
    expect(nextPollDelayMs(1 * MIN)).toBe(MIN);
    expect(nextPollDelayMs(14 * MIN)).toBe(MIN);
    expect(nextPollDelayMs(15 * MIN)).toBe(5 * MIN);
    expect(nextPollDelayMs(119 * MIN)).toBe(5 * MIN);
    expect(nextPollDelayMs(120 * MIN)).toBe(30 * MIN);
    expect(nextPollDelayMs(23 * 60 * MIN)).toBe(30 * MIN);
  });
});

describe('the reconciliation poller follows the schedule', () => {
  it('a still-pending link is scheduled by its age', async () => {
    const young = await insertPending(2 * MIN);
    const middle = await insertPending(30 * MIN);
    const old = await insertPending(3 * 60 * MIN);

    const before = Date.now();
    await h.whish.reconcileStalePayments();

    const nextIn = async (id: string) => (await rowOf(id)).nextPollAt!.getTime() - before;
    // A few seconds early on purpose (so the next tick never misses it by jitter).
    expect(await nextIn(young.id)).toBeGreaterThan(50_000);
    expect(await nextIn(young.id)).toBeLessThanOrEqual(MIN);
    expect(await nextIn(middle.id)).toBeGreaterThan(4 * MIN);
    expect(await nextIn(middle.id)).toBeLessThanOrEqual(5 * MIN);
    expect(await nextIn(old.id)).toBeGreaterThan(29 * MIN);
    expect(await nextIn(old.id)).toBeLessThanOrEqual(30 * MIN);
  });

  it('a link checked this tick is not asked about again until it is due', async () => {
    const p = await insertPending(5 * MIN);
    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([p.externalId]);

    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([p.externalId]); // not due yet

    // Its time comes → checked again.
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: p.id },
        data: { nextPollAt: new Date(Date.now() - 1) },
      }),
    );
    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([p.externalId, p.externalId]);
  });

  it('links Whish never resolves cannot starve a newer link (the old oldest-first bug)', async () => {
    // Two links stuck pending for hours fill a per-tick budget of 2…
    const stuck = [await insertPending(5 * 60 * MIN), await insertPending(4 * 60 * MIN)];
    // …and a customer pays a newer link whose success callback was lost.
    const newer = await insertPending(3 * MIN);
    h.whishClient.statusFor.set(newer.externalId, 'success');

    // Tick 1: the two oldest (never-polled) are due first and take the budget.
    await h.whish.reconcileStalePayments({ limit: 2 });
    expect([...h.whishClient.getStatusCalls].sort()).toEqual(stuck.map((s) => s.externalId).sort());
    expect((await rowOf(newer.id)).status).toBe('PENDING');

    // Tick 2: the stuck links are scheduled 30 minutes out, so the newer one
    // is next — before, the same two stuck links were polled every tick for up
    // to 24 hours and this deposit was never booked.
    await h.whish.reconcileStalePayments({ limit: 2 });
    expect(h.whishClient.getStatusCalls.slice(2)).toEqual([newer.externalId]);
    const settled = await rowOf(newer.id);
    expect(settled.status).toBe('PAID');
    expect(settled.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('paid-but-unsettled links (needsAttention) never take a slot', async () => {
    const flagged = [
      await insertPending(60 * MIN, { metadata: { needsAttention: true, paidButUnsettled: true } }),
      await insertPending(50 * MIN, { metadata: { needsAttention: true } }),
    ];
    // Metadata present but WITHOUT the flag — must still be polled.
    const normal = await insertPending(10 * MIN, { metadata: { lastCollectStatus: 'pending' } });

    const res = await h.whish.reconcileStalePayments({ limit: 2 });

    expect(res.checked).toBe(1);
    expect(h.whishClient.getStatusCalls).toEqual([normal.externalId]);
    for (const f of flagged) expect((await rowOf(f.id)).nextPollAt).toBeNull();
  });

  it('an upstream error retries in about a minute, behind the links already due', async () => {
    const p = await insertPending(10 * 60 * MIN);
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    const before = Date.now();
    await h.whish.reconcileStalePayments();

    const row = await rowOf(p.id);
    expect(row.status).toBe('PENDING'); // never closed on an upstream blip
    const nextIn = row.nextPollAt!.getTime() - before;
    expect(nextIn).toBeGreaterThan(50_000);
    expect(nextIn).toBeLessThanOrEqual(MIN);
  });

  it('a link written before the schedule existed (next_poll_at NULL) is polled as before', async () => {
    const tooYoung = await insertPending(30_000); // < 1 minute old: not yet
    const legacy = await insertPending(2 * MIN);

    await h.whish.reconcileStalePayments();

    expect(h.whishClient.getStatusCalls).toEqual([legacy.externalId]);
    expect((await rowOf(tooYoung.id)).nextPollAt).toBeNull();
  });

  it('a link Whish reports failed is closed and leaves the schedule', async () => {
    const p = await insertPending(7 * MIN);
    h.whishClient.statusFor.set(p.externalId, 'failed');

    await h.whish.reconcileStalePayments();

    expect((await rowOf(p.id)).status).toBe('FAILED');
    expect(h.crm.names()).toContain('transaction.failed');
    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([p.externalId]); // never asked again
  });

  it('the 24h backstop still closes a link Whish never resolved', async () => {
    const p = await insertPending(25 * 60 * MIN);
    await h.whish.reconcileStalePayments();
    expect((await rowOf(p.id)).status).toBe('FAILED');
  });
});
