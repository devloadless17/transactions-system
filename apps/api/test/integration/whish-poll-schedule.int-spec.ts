/**
 * The Whish reconciliation poller follows a SCHEDULE (whish_payments.next_poll_at):
 * the links due now, earliest-due first, each next check paced by the link's
 * age. It is the backstop for Whish deposits — Whish only calls back on a
 * success, so a failed link reaches the company's CRM, and a success whose
 * callback was lost is booked, only when the poller asks Whish.
 *
 * Its timing follows Whish: a link is payable for about 5 minutes, and Whish
 * tells us itself when one is paid. So a link is not asked about while it can
 * still be paid (first check at 6 minutes), and one Whish still reports unpaid
 * at 10 minutes is closed.
 *
 * Pinned here against the real database:
 *   - no check before 6 minutes, and the close at 10;
 *   - a link Whish reports as 'unknown' (it may have collected) is NOT closed
 *     at 10 minutes — it is asked about until Whish answers;
 *   - links Whish cannot resolve never starve newer links;
 *   - paid-but-unsettled links (needsAttention) never take a slot;
 *   - a callback we could not act on, or a payment we could not book, is
 *     retried at the poller's next run — it does not wait for the first check;
 *   - each check schedules the next one by age, and an upstream error never
 *     closes a link or holds the head of the queue.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('nextPollDelayMs — every minute until the 10-minute cutoff, every 5 minutes past it', () => {
  it('asks every minute while Whish is about to close the link, then every 5 minutes', () => {
    expect(nextPollDelayMs(6 * MIN)).toBe(MIN);
    expect(nextPollDelayMs(10 * MIN - 1)).toBe(MIN);
    expect(nextPollDelayMs(10 * MIN)).toBe(5 * MIN);
    expect(nextPollDelayMs(23 * 60 * MIN)).toBe(5 * MIN);
  });
});

describe('the reconciliation poller follows the schedule', () => {
  it('a link is not asked about while it can still be paid — the first check is at 6 minutes', async () => {
    // Whish reports a payment itself (the success callback), so asking about a
    // link that is still open would only ever answer "pending".
    const payable = [await insertPending(30_000), await insertPending(5 * MIN)];
    const due = await insertPending(6 * MIN + 5_000);

    await h.whish.reconcileStalePayments();

    expect(h.whishClient.getStatusCalls).toEqual([due.externalId]);
    for (const p of payable) expect((await rowOf(p.id)).nextPollAt).toBeNull();
  });

  it('a still-unresolved link is scheduled by its age', async () => {
    const young = await insertPending(7 * MIN);
    // Past the cutoff only a link Whish cannot resolve is still open.
    const old = await insertPending(3 * 60 * MIN);
    h.whishClient.statusFor.set(old.externalId, 'unknown');

    const before = Date.now();
    await h.whish.reconcileStalePayments();

    const nextIn = async (id: string) => (await rowOf(id)).nextPollAt!.getTime() - before;
    // A few seconds early on purpose (so the next tick never misses it by jitter).
    expect(await nextIn(young.id)).toBeGreaterThan(50_000);
    expect(await nextIn(young.id)).toBeLessThanOrEqual(MIN);
    expect(await nextIn(old.id)).toBeGreaterThan(4 * MIN);
    expect(await nextIn(old.id)).toBeLessThanOrEqual(5 * MIN);
  });

  it('a link checked this tick is not asked about again until it is due', async () => {
    const p = await insertPending(7 * MIN);
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

  it('links Whish cannot resolve never starve a newer link (the old oldest-first bug)', async () => {
    // Two links Whish has reported as 'unknown' for hours fill a per-tick budget of 2…
    const stuck = [await insertPending(5 * 60 * MIN), await insertPending(4 * 60 * MIN)];
    for (const s of stuck) h.whishClient.statusFor.set(s.externalId, 'unknown');
    // …and a customer paid a newer link whose success callback was lost.
    const newer = await insertPending(7 * MIN);
    h.whishClient.statusFor.set(newer.externalId, 'success');

    // Tick 1: the two oldest (never-polled) are due first and take the budget.
    await h.whish.reconcileStalePayments({ limit: 2 });
    expect([...h.whishClient.getStatusCalls].sort()).toEqual(stuck.map((s) => s.externalId).sort());
    expect((await rowOf(newer.id)).status).toBe('PENDING');

    // Tick 2: the stuck links are scheduled 5 minutes out, so the newer one is
    // next — before the schedule, the same two stuck links were polled every
    // tick and this deposit was never booked.
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
    const normal = await insertPending(7 * MIN, { metadata: { lastCollectStatus: 'pending' } });

    const res = await h.whish.reconcileStalePayments({ limit: 2 });

    expect(res.checked).toBe(1);
    expect(h.whishClient.getStatusCalls).toEqual([normal.externalId]);
    for (const f of flagged) expect((await rowOf(f.id)).nextPollAt).toBeNull();
  });

  it('an upstream error never closes a link — it is asked again in about a minute', async () => {
    const young = await insertPending(7 * MIN);
    const old = await insertPending(10 * 60 * MIN); // far past the cutoff
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    const before = Date.now();
    await h.whish.reconcileStalePayments();

    for (const p of [young, old]) {
      const row = await rowOf(p.id);
      // We could not read its status, so we do not know it is unpaid — and it
      // may be a paid deposit waiting to be booked, so the retry is not slowed.
      expect(row.status).toBe('PENDING');
      const nextIn = row.nextPollAt!.getTime() - before;
      expect(nextIn).toBeGreaterThan(50_000);
      expect(nextIn).toBeLessThanOrEqual(MIN);
    }
    expect(h.crm.names()).toEqual([]);
  });

  it('a Whish callback we could not act on is retried at the next run, not at the 6-minute check', async () => {
    // One minute old: still payable, so the poller would not look at it yet.
    const p = await insertPending(MIN);
    const { callbackToken } = await rowOf(p.id);
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    // Whish says "paid"; we cannot verify it with Whish right now.
    expect(await h.whish.handleCallback(Number(p.externalId), callbackToken)).toBe(true);

    const waiting = await rowOf(p.id);
    expect(waiting.status).toBe('PENDING');
    expect(waiting.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now()); // due now

    // Whish answers again → booked by the very next run.
    h.whishClient.failGetStatusWith = null;
    h.whishClient.statusFor.set(p.externalId, 'success');
    await h.whish.reconcileStalePayments();

    const settled = await rowOf(p.id);
    expect(settled.status).toBe('PAID');
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('a payment Whish collected but we could not book is retried at the next run', async () => {
    const p = await insertPending(MIN);
    h.whishClient.statusFor.set(p.externalId, 'success');
    // The booking fails once (a database blip), then works.
    const ingest = vi
      .spyOn(h.transactions, 'ingest')
      .mockRejectedValueOnce(new Error('could not serialize access'));

    try {
      // Whoever asked — here the company's own refresh, not a callback.
      await expect(h.whish.refreshStatus(companyId, p.id)).rejects.toThrow();

      const waiting = await rowOf(p.id);
      expect(waiting.status).toBe('PENDING');
      expect(waiting.metadata).toMatchObject({ paidButUnsettled: true, settlementAttempts: 1 });
      expect((waiting.metadata as { needsAttention?: boolean }).needsAttention).toBeUndefined();
      expect(waiting.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now()); // due now

      await h.whish.reconcileStalePayments();
    } finally {
      ingest.mockRestore();
    }

    const settled = await rowOf(p.id);
    expect(settled.status).toBe('PAID');
    expect(settled.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
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

  it('a shutdown stops the run between links — a link already being checked finishes', async () => {
    // A run can take minutes (250 links, Whish calls of up to 10s); a deploy must
    // not wait for it, and must never leave a link half-handled.
    const links = await Promise.all(
      Array.from({ length: 12 }, (_, i) => insertPending((6.5 + i * 0.25) * MIN)),
    );

    const res = await h.whish.reconcileStalePayments({
      shouldStop: () => h.whishClient.getStatusCalls.length >= 1, // the stop arrives at once
    });

    // Each of the 4 workers finished the link it had started, then stopped.
    expect(res.checked).toBeGreaterThan(0);
    expect(res.checked).toBeLessThanOrEqual(4);
    expect(h.whishClient.getStatusCalls).toHaveLength(res.checked);
    // Every link that was started was fully handled (asked and rescheduled);
    // the rest were left untouched for the next instance.
    const rows = await Promise.all(links.map((l) => rowOf(l.id)));
    expect(rows.filter((r) => r.nextPollAt !== null)).toHaveLength(res.checked);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('a link Whish still reports unpaid 10 minutes after it was created is closed', async () => {
    const open = await insertPending(9 * MIN);
    const lapsed = await insertPending(10 * MIN + 5_000);

    const res = await h.whish.reconcileStalePayments();

    expect(res).toEqual({ checked: 2, timedOut: 1 });
    expect((await rowOf(open.id)).status).toBe('PENDING');
    const closed = await rowOf(lapsed.id);
    expect(closed.status).toBe('FAILED');
    expect(
      (closed.metadata as { needsAttention?: boolean } | null)?.needsAttention,
    ).toBeUndefined();
    expect(h.crm.names()).toEqual(['transaction.failed']);
    // Closed for good: never asked about again.
    h.whishClient.getStatusCalls = [];
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id: { in: [open.id, lapsed.id] } },
        data: { nextPollAt: new Date(Date.now() - 1) },
      }),
    );
    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([open.externalId]);
  });

  it("a link Whish reports as 'unknown' is NOT closed at 10 minutes — it may have been paid", async () => {
    const p = await insertPending(11 * MIN);
    h.whishClient.statusFor.set(p.externalId, 'unknown');

    const before = Date.now();
    const res = await h.whish.reconcileStalePayments();

    expect(res.timedOut).toBe(0);
    const row = await rowOf(p.id);
    expect(row.status).toBe('PENDING');
    expect(row.metadata).toMatchObject({ lastCollectStatus: 'unknown' });
    expect((row.metadata as { needsAttention?: boolean }).needsAttention).toBeUndefined();
    expect(h.crm.names()).toEqual([]); // the CRM is NOT told it failed
    expect(row.nextPollAt!.getTime() - before).toBeGreaterThan(4 * MIN);

    // Whish then resolves it: the customer had paid. Booked at the next check.
    h.whishClient.statusFor.set(p.externalId, 'success');
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: p.id },
        data: { nextPollAt: new Date(Date.now() - 1) },
      }),
    );
    await h.whish.reconcileStalePayments();

    const settled = await rowOf(p.id);
    expect(settled.status).toBe('PAID');
    expect(settled.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it("an 'unknown' link that Whish then reports unpaid is closed like any other", async () => {
    const p = await insertPending(11 * MIN);
    h.whishClient.statusFor.set(p.externalId, 'unknown');
    await h.whish.reconcileStalePayments();
    expect((await rowOf(p.id)).status).toBe('PENDING');

    // Whish can tell again, and the link is still unpaid: past the cutoff → closed.
    h.whishClient.statusFor.set(p.externalId, 'pending');
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: p.id },
        data: { nextPollAt: new Date(Date.now() - 1) },
      }),
    );
    const res = await h.whish.reconcileStalePayments();

    expect(res.timedOut).toBe(1);
    const closed = await rowOf(p.id);
    expect(closed.status).toBe('FAILED');
    expect((closed.metadata as { needsAttention?: boolean }).needsAttention).toBeUndefined();
  });
});
