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

  it('exportCsv returns a header plus one row per transaction (keyset walk)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    for (const amount of ['100', '200', '300']) {
      await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, amount));
    }

    const csv = await h.transactions.exportCsv({
      companyId,
      query: { page: 1, pageSize: 20 },
    });
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
});
