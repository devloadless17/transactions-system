/**
 * The Whish reconciliation poller follows a SCHEDULE (whish_payments.next_poll_at):
 * the links due now, earliest-due first, each next check paced by the link's
 * age. It is the backstop for Whish deposits — Whish only calls back on a
 * success, so a failed link reaches the company's CRM, and a success whose
 * callback was lost is booked, only when the poller asks Whish.
 *
 * Its timing follows Whish: a link is payable for 5 minutes, and Whish tells us
 * itself when one is paid. So a link is not asked about while it can still be
 * paid — its one scheduled check comes 5:10 after it was created — and one
 * Whish still reports unpaid at 10 minutes is closed.
 *
 * Pinned here against the real database:
 *   - a link is on the schedule from birth: no check before 5:10, the close at 10;
 *   - a run reads only the head of the schedule, and says when a batch was full;
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
import { JobLeaseService } from '../../src/database/job-lease.service';
import { WhishError } from '../../src/modules/whish/whish.client';
import { WhishReconciliationService } from '../../src/modules/whish/whish-reconciliation.service';
import {
  FIRST_POLL_AGE_MS,
  nextPollDelayMs,
  RECONCILE_CONCURRENCY,
} from '../../src/modules/whish/whish-payments.service';
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

/**
 * A PENDING link created `ageMs` ago, on the schedule the way createPayment
 * puts it there: first check FIRST_POLL_AGE_MS after creation. `nextPollAt:
 * null` = a row written before links were scheduled at birth.
 */
async function insertPending(
  ageMs: number,
  extra: { metadata?: object; nextPollAt?: Date | null } = {},
): Promise<{ id: string; externalId: string }> {
  const createdAt = new Date(Date.now() - ageMs);
  const nextPollAt =
    extra.nextPollAt === undefined
      ? new Date(createdAt.getTime() + FIRST_POLL_AGE_MS)
      : extra.nextPollAt;
  const row = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: `it-poll-${Date.now().toString(36)}-${tok++}`,
        amount: '50.00',
        currency: USD,
        invoice: 'inv-poll',
        status: WhishPaymentStatus.PENDING,
        createdAt,
        ...(extra.metadata ? { metadata: extra.metadata } : {}),
        ...(nextPollAt ? { nextPollAt } : {}),
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

describe('nextPollDelayMs — one check at 5:10, every minute to the 10-minute cutoff, then every 5', () => {
  it('sends a link asked about early back to its first check', () => {
    expect(FIRST_POLL_AGE_MS).toBe(5 * MIN + 10_000);
    expect(nextPollDelayMs(0)).toBe(FIRST_POLL_AGE_MS);
    expect(nextPollDelayMs(2 * MIN)).toBe(3 * MIN + 10_000);
    expect(nextPollDelayMs(FIRST_POLL_AGE_MS - 1)).toBe(1);
  });

  it('asks every minute while Whish is about to close the link, then every 5 minutes', () => {
    expect(nextPollDelayMs(FIRST_POLL_AGE_MS)).toBe(MIN);
    expect(nextPollDelayMs(10 * MIN - 1)).toBe(MIN);
    expect(nextPollDelayMs(10 * MIN)).toBe(5 * MIN);
    expect(nextPollDelayMs(23 * 60 * MIN)).toBe(5 * MIN);
  });
});

describe('the reconciliation poller follows the schedule', () => {
  it('a new link is put on the schedule at birth: first check 5:10 after Whish made it', async () => {
    const before = Date.now();
    const created = await h.whish.createPayment(companyId, {
      amount: '50.00',
      currency: USD,
      invoice: 'inv-born',
    });
    const after = Date.now();

    const at = (await rowOf(created.id)).nextPollAt!.getTime();
    expect(at).toBeGreaterThanOrEqual(before + FIRST_POLL_AGE_MS);
    expect(at).toBeLessThanOrEqual(after + FIRST_POLL_AGE_MS);
    // …so the poller leaves it alone until then.
    await h.whish.reconcileStalePayments();
    expect(h.whishClient.getStatusCalls).toEqual([]);
  });

  it('a link is not asked about while it can still be paid — its check is 5:10 after creation', async () => {
    // Whish reports a payment itself (the success callback), so asking about a
    // link that is still open would only ever answer "pending".
    const payable = [
      await insertPending(30_000),
      await insertPending(5 * MIN), // Whish is closing it about now
      await insertPending(FIRST_POLL_AGE_MS - 2_000),
    ];
    const due = await insertPending(FIRST_POLL_AGE_MS + 1_000);

    const res = await h.whish.reconcileStalePayments();

    expect(res).toEqual({ checked: 1, timedOut: 0, more: false, throttled: false });
    expect(h.whishClient.getStatusCalls).toEqual([due.externalId]);
    // The next thing due is the link 2 seconds short of its check.
    const next = await h.whish.nextPollDueAt();
    expect(next! - Date.now()).toBeGreaterThan(0);
    expect(next! - Date.now()).toBeLessThanOrEqual(2_000);
    expect(next).toBe((await rowOf(payable[2]!.id)).nextPollAt!.getTime());
  });

  it('a run takes the head of the schedule, earliest-due first, and says when the batch was full', async () => {
    const third = await insertPending(6 * MIN);
    const first = await insertPending(8 * MIN);
    const second = await insertPending(7 * MIN);
    await insertPending(MIN); // still payable

    const res = await h.whish.reconcileStalePayments({ limit: 2 });

    expect(res).toEqual({ checked: 2, timedOut: 0, more: true, throttled: false });
    expect([...h.whishClient.getStatusCalls].sort()).toEqual(
      [first.externalId, second.externalId].sort(),
    );
    // More is due right now: that is what the caller runs again for.
    expect(await h.whish.nextPollDueAt()).toBeLessThanOrEqual(Date.now());
    expect((await h.whish.reconcileStalePayments({ limit: 2 })).more).toBe(false);
    expect(h.whishClient.getStatusCalls.at(-1)).toBe(third.externalId);
  });

  it('a row written before links were scheduled at birth is asked about once, then put on the schedule', async () => {
    const legacy = await insertPending(MIN, { nextPollAt: null });
    const { createdAt } = await rowOf(legacy.id);

    await h.whish.reconcileStalePayments();
    await h.whish.reconcileStalePayments();

    expect(h.whishClient.getStatusCalls).toEqual([legacy.externalId]); // once, not every run
    expect((await rowOf(legacy.id)).nextPollAt!.getTime()).toBe(
      createdAt.getTime() + FIRST_POLL_AGE_MS,
    );
  });

  it('a still-unresolved link is scheduled by its age', async () => {
    const young = await insertPending(7 * MIN);
    // Past the cutoff only a link Whish cannot resolve is still open.
    const old = await insertPending(3 * 60 * MIN);
    h.whishClient.statusFor.set(old.externalId, 'unknown');

    const before = Date.now();
    await h.whish.reconcileStalePayments();
    const took = Date.now() - before;

    const nextIn = async (id: string) => (await rowOf(id)).nextPollAt!.getTime() - before;
    expect(await nextIn(young.id)).toBeGreaterThanOrEqual(MIN);
    expect(await nextIn(young.id)).toBeLessThanOrEqual(MIN + took);
    expect(await nextIn(old.id)).toBeGreaterThanOrEqual(5 * MIN);
    expect(await nextIn(old.id)).toBeLessThanOrEqual(5 * MIN + took);
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

    const scheduled = await Promise.all(flagged.map(async (f) => (await rowOf(f.id)).nextPollAt));

    const res = await h.whish.reconcileStalePayments({ limit: 2 });

    expect(res.checked).toBe(1);
    expect(h.whishClient.getStatusCalls).toEqual([normal.externalId]);
    // Untouched, and they do not decide when the poller comes back either.
    for (const [i, f] of flagged.entries()) {
      expect((await rowOf(f.id)).nextPollAt).toEqual(scheduled[i]);
    }
    expect(await h.whish.nextPollDueAt()).toBe((await rowOf(normal.id)).nextPollAt!.getTime());
  });

  it('an upstream error never closes a link — it is asked again in about a minute', async () => {
    const young = await insertPending(7 * MIN);
    const old = await insertPending(10 * 60 * MIN); // far past the cutoff
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    const before = Date.now();
    await h.whish.reconcileStalePayments();
    const took = Date.now() - before;

    for (const p of [young, old]) {
      const row = await rowOf(p.id);
      // We could not read its status, so we do not know it is unpaid — and it
      // may be a paid deposit waiting to be booked, so the retry is not slowed.
      expect(row.status).toBe('PENDING');
      const nextIn = row.nextPollAt!.getTime() - before;
      expect(nextIn).toBeGreaterThanOrEqual(MIN);
      expect(nextIn).toBeLessThanOrEqual(MIN + took);
    }
    expect(h.crm.names()).toEqual([]);
  });

  it('if Whish answers "too many requests" the run stops at once and says so', async () => {
    const links = await Promise.all(
      // More links than the checks that run at once.
      Array.from({ length: RECONCILE_CONCURRENCY + 20 }, (_, i) =>
        insertPending((6.5 + i * 0.05) * MIN),
      ),
    );
    h.whishClient.failGetStatusWith = new WhishError('Too many requests', { httpStatus: 429 });

    const res = await h.whish.reconcileStalePayments();

    // The checks already in flight finish; no further link is started.
    expect(res.throttled).toBe(true);
    expect(res.checked).toBeLessThanOrEqual(RECONCILE_CONCURRENCY);
    expect(h.whishClient.getStatusCalls).toHaveLength(res.checked);
    const rows = await Promise.all(links.map((l) => rowOf(l.id)));
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true); // nothing closed
    // The links it asked about retry in a minute; the rest are still due.
    expect(rows.filter((r) => r.nextPollAt!.getTime() > Date.now())).toHaveLength(res.checked);
    expect(h.crm.names()).toEqual([]);
  });

  it('an ordinary Whish error does not stop the run', async () => {
    const links = [await insertPending(7 * MIN), await insertPending(8 * MIN)];
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    const res = await h.whish.reconcileStalePayments();

    expect(res).toEqual({ checked: 2, timedOut: 0, more: false, throttled: false });
    expect(h.whishClient.getStatusCalls).toHaveLength(links.length);
  });

  it('a Whish callback we could not act on is retried at the next run, not at its 5:10 check', async () => {
    // One minute old: still payable, so the poller would not look at it yet.
    const p = await insertPending(MIN);
    const { callbackToken } = await rowOf(p.id);
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    // Whish says "paid"; we cannot verify it with Whish right now.
    expect(await h.whish.handleCallback(Number(p.externalId), callbackToken)).toBe(true);

    const waiting = await rowOf(p.id);
    expect(waiting.status).toBe('PENDING');
    expect(waiting.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now()); // due now
    expect(await h.whish.nextPollDueAt()).toBeLessThanOrEqual(Date.now());

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
      // More links than the checks that run at once.
      Array.from({ length: RECONCILE_CONCURRENCY + 20 }, (_, i) =>
        insertPending((6.5 + i * 0.05) * MIN),
      ),
    );

    const res = await h.whish.reconcileStalePayments({
      shouldStop: () => h.whishClient.getStatusCalls.length >= 1, // the stop arrives at once
    });

    // Each worker finished the link it had started, then stopped.
    expect(res.checked).toBeGreaterThan(0);
    expect(res.checked).toBeLessThanOrEqual(RECONCILE_CONCURRENCY);
    expect(h.whishClient.getStatusCalls).toHaveLength(res.checked);
    // Every link that was started was fully handled (asked and rescheduled);
    // the rest were left untouched — still due — for the next instance.
    const rows = await Promise.all(links.map((l) => rowOf(l.id)));
    expect(rows.filter((r) => r.nextPollAt!.getTime() > Date.now())).toHaveLength(res.checked);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('a link Whish still reports unpaid 10 minutes after it was created is closed', async () => {
    const open = await insertPending(9 * MIN);
    const lapsed = await insertPending(10 * MIN + 5_000);

    const res = await h.whish.reconcileStalePayments();

    expect(res).toEqual({ checked: 2, timedOut: 1, more: false, throttled: false });
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
    expect(row.nextPollAt!.getTime() - before).toBeGreaterThanOrEqual(5 * MIN);

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

describe('the poller comes back when a link is due (real clock, real lease, real database)', () => {
  it('asks Whish within a moment of the due time, not at the next every-minute pass', async () => {
    const poller = new WhishReconciliationService(h.whish, new JobLeaseService(h.prisma));
    // A link whose one scheduled check falls 3 seconds from now.
    const p = await insertPending(FIRST_POLL_AGE_MS - 3_000);
    const dueAt = (await rowOf(p.id)).nextPollAt!.getTime();
    h.whishClient.statusFor.set(p.externalId, 'failed'); // Whish closed it at 5:00

    try {
      // An every-minute pass: nothing is due, so Whish is not asked…
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (poller as any).tick(true);
      expect(h.whishClient.getStatusCalls).toEqual([]);

      // …and the poller comes back by itself when the link falls due.
      await vi.waitFor(async () => expect((await rowOf(p.id)).status).toBe('FAILED'), {
        timeout: 20_000,
        interval: 50,
      });
    } finally {
      poller.onModuleDestroy();
    }

    const closed = await rowOf(p.id);
    const late = closed.updatedAt.getTime() - dueAt;
    expect(late).toBeGreaterThanOrEqual(0); // never before its time
    // Without the wake-up only the next every-minute pass would ask: ~57s late.
    // Measured locally at ~0.2s; the bound leaves room for a loaded machine's
    // clock (WSL once took 3.5s), and is still far from a minute.
    expect(late).toBeLessThan(15_000);
    expect(h.whishClient.getStatusCalls).toEqual([p.externalId]); // asked exactly once
    expect(h.crm.names()).toEqual(['transaction.failed']);
  });
});
