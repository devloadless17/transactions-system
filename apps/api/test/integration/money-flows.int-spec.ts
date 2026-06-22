/**
 * Integration tests for the core money flows against the real DB. These guard
 * the invariants a refactor could silently break: the ledger always balances,
 * the wallet is a faithful projection of the ledger, idempotency holds, and a
 * reversal that can't be covered books the shortfall as a RECEIVABLE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  addTransactionFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  snapshot,
  type Harness,
} from './harness';

/** Money-aware equality so 90 and 90.00000000 compare equal. */
const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('ingest', () => {
  it('books balanced double-entry and credits the wallet with the net', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // 10%

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.commissionAmount, '10')).toBe(true);
    expect(eq(txn.netAmount, '90')).toBe(true);

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true); // EXTERNAL 100 dr == AVAILABLE 90 cr + FEE 10 cr
    expect(eq(snap.availableLedger, '90')).toBe(true);
    expect(snap.wallet).not.toBeNull();
    expect(eq(snap.wallet!.available, snap.availableLedger)).toBe(true);
    expect(eq(snap.receivableLedger, '0')).toBe(true);
  });

  it('is idempotent on a repeated (source, externalTransactionId)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    const input = ingestInput(companyId, '100');
    const first = await h.transactions.ingest({ kind: 'source', sourceId }, input);
    const second = await h.transactions.ingest({ kind: 'source', sourceId }, input);

    expect(second.id).toBe(first.id); // replayed, not re-booked
    const snap = await snapshot(h, companyId);
    expect(eq(snap.wallet!.available, '90')).toBe(true); // not 180
    expect(snap.balanced).toBe(true);
  });

  it('streamCsv emits a header plus one row per transaction (keyset walk)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    for (const amount of ['100', '200', '300']) {
      await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, amount));
    }

    const file = h.transactions.streamCsv({
      companyId,
      query: { page: 1, pageSize: 20 },
    });
    let csv = '';
    for await (const chunk of file.getStream()) csv += chunk;
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[0]).toContain('external_transaction_id');
  });
});

describe('withdrawal', () => {
  it('moves available → reserved on request, reserved → external on approval', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('40'));

    const afterRequest = await snapshot(h, companyId);
    expect(afterRequest.balanced).toBe(true);
    expect(eq(afterRequest.wallet!.available, '50')).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, '40')).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, afterRequest.reservedLedger)).toBe(true);

    await h.withdrawals.approve(w.id, userId, { externalReference: 'pay-ref-001' });

    const afterApprove = await snapshot(h, companyId);
    expect(afterApprove.balanced).toBe(true);
    expect(eq(afterApprove.wallet!.available, '50')).toBe(true);
    expect(eq(afterApprove.wallet!.reserved, '0')).toBe(true);
    expect(eq(afterApprove.wallet!.available, afterApprove.availableLedger)).toBe(true);
  });

  it('rejects a withdrawal that exceeds the available balance', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    await expect(
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('1000')),
    ).rejects.toThrow();

    // Nothing moved — wallet untouched, books still balanced.
    const snap = await snapshot(h, companyId);
    expect(eq(snap.wallet!.available, '90')).toBe(true);
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
    expect(snap.balanced).toBe(true);
  });

  it('cancel works with a null actor (API-key caller) — no user-FK violation, funds released', async () => {
    // A company API key has no real users row; the controller passes null for the
    // requester/canceller. Cancelling must not write a non-user id into the
    // cancelled_by FK — this guards the bug where the key id leaked into it.
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    const w = await h.withdrawals.request(companyId, null, cashWithdrawalInput('40'));
    const cancelled = await h.withdrawals.cancel(w.id, companyId, null, { notes: 'via api key' });
    expect(cancelled.status).toBe('CANCELLED');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.available, '90')).toBe(true); // the reserved 40 was released
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
  });
});

describe('concurrency', () => {
  it('two simultaneous withdrawals cannot overspend the same wallet (no double-spend)', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // 10%
    // Ingest 100 → net 90 available.
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // Fire two withdrawals of 60 at the exact same time: together 120 > 90, so
    // only one can be funded. This is the crown-jewel invariant — SERIALIZABLE
    // isolation + the wallet version-CAS must let exactly one reserve the money;
    // the other is refused, never double-spent.
    const results = await Promise.allSettled([
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('60')),
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('60')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // Wallet reflects exactly one reservation: never negative, books still balance.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.available, '30')).toBe(true); // 90 − 60, not −30
    expect(eq(snap.wallet!.reserved, '60')).toBe(true);
    expect(eq(snap.wallet!.reserved, snap.reservedLedger)).toBe(true);
  });
});

describe('reversal', () => {
  it('books the uncovered clawback as a RECEIVABLE when funds were withdrawn', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    // Ingest 100 → net 90 to available.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    // Withdraw all 90 and approve → available 0.
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));
    await h.withdrawals.approve(w.id, userId, { externalReference: 'pay-ref-002' });
    expect(eq((await snapshot(h, companyId)).wallet!.available, '0')).toBe(true);

    // Reverse the ingest: net (90) can't be clawed from available (0) → RECEIVABLE 90.
    const reversed = await h.transactions.reverse(txn.id, {
      actorId: userId,
      reason: 'chargeback',
    });
    expect(reversed.status).toBe('REVERSED');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true); // EXTERNAL 100 cr == RECEIVABLE 90 dr + FEE 10 dr
    expect(eq(snap.receivableLedger, '90')).toBe(true); // company now owes 90
    expect(eq(snap.wallet!.available, '0')).toBe(true); // never goes negative
  });

  it('blocks a new withdrawal while a RECEIVABLE is outstanding', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));
    await h.withdrawals.approve(w.id, userId, { externalReference: 'pay-ref-003' });
    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });

    // Top the wallet back up, but the debt must still block money-out.
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));
    await expect(
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('5')),
    ).rejects.toThrow(/owed to the platform/i);
  });

  it('blocks APPROVING a pending withdrawal when a reversal booked a RECEIVABLE after it reserved', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    // Ingest 100 → net 90 available.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    // Request a withdrawal (reserves 90: available 90→0, reserved 90) — but DON'T approve yet.
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));

    // Reverse the funding ingest WHILE the withdrawal is still PENDING. The
    // clawback claims `available` (now 0), so the full 90 books to RECEIVABLE
    // and the reserved 90 is left intact and still PENDING.
    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    const mid = await snapshot(h, companyId);
    expect(eq(mid.receivableLedger, '90')).toBe(true);
    expect(eq(mid.reservedLedger, '90')).toBe(true);

    // FIX D: approving now would send 90 out while the company owes 90 (a double
    // loss). Approval must be blocked until the debt is settled.
    await expect(
      h.withdrawals.approve(w.id, userId, { externalReference: 'should-be-blocked' }),
    ).rejects.toThrow(/owed to the platform/i);

    // The withdrawal stays PENDING and the books remain balanced (no money left).
    const after = await snapshot(h, companyId);
    expect(after.balanced).toBe(true);
    expect(eq(after.reservedLedger, '90')).toBe(true);
  });

  it('settles an outstanding RECEIVABLE from an incoming load before crediting available', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    // Book a 90 RECEIVABLE: ingest 100 → net 90, withdraw+approve 90, reverse.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));
    await h.withdrawals.approve(w.id, userId, { externalReference: 'pay-ref-004' });
    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    expect(eq((await snapshot(h, companyId)).receivableLedger, '90')).toBe(true);

    // Load 50 (no LOAD fee) → settles 50 of the debt; nothing reaches available.
    const l1 = await h.loads.request(companyId, userId, loadInput('50'));
    await h.loads.approve(l1.id, userId, { externalReference: 'load-ref-001' });
    const partial = await snapshot(h, companyId);
    expect(partial.balanced).toBe(true); // ledger still balances
    expect(eq(partial.receivableLedger, '40')).toBe(true); // 90 − 50 settled
    expect(eq(partial.wallet!.available, '0')).toBe(true); // all went to the debt

    // Load 100 → settles the remaining 40, credits the 60 remainder to available.
    const l2 = await h.loads.request(companyId, userId, loadInput('100'));
    await h.loads.approve(l2.id, userId, { externalReference: 'load-ref-002' });
    const full = await snapshot(h, companyId);
    expect(full.balanced).toBe(true);
    expect(eq(full.receivableLedger, '0')).toBe(true); // debt cleared
    expect(eq(full.wallet!.available, '60')).toBe(true); // 100 − 40
    expect(eq(full.wallet!.available, full.availableLedger)).toBe(true);

    // Debt settled → money-out is unblocked again.
    const w2 = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('10'));
    expect(w2.status).toBe('PENDING');
  });
});
