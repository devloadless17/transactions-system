/**
 * Pins the source-fee best-effort fallback in the ingest path.
 *
 * Source fee = what an upstream source charges THE PLATFORM per deposit. It is a
 * REPORTING figure, frozen on the transaction at settlement, and is computed
 * OUTSIDE the money transaction precisely so that a failure to read the fee
 * schedule can never block or roll back a real deposit (see
 * transactions.service.ts `ingest`: the source-fee-rule fetch is wrapped in
 * try/catch and defaults `source_fee_amount` to 0 on any error).
 *
 * This test forces that catch: it injects a `sourceFeeRule.findMany` that throws
 * inside the admin transaction, and asserts the deposit STILL settles with
 * `source_fee_amount = 0` while the double-entry ledger stays balanced. It must
 * FAIL if the try/catch is removed (the error would propagate and reject ingest).
 *
 * NOTE (fee-rule caching): the fee-rule fetch is wrapped in CacheService.wrap;
 * the harness cache is pass-through, so the failure injected on `runAsAdmin`
 * (the seam the wrapped fn calls) still reaches the try/catch. If the read ever
 * moves to a different boundary, inject the failure there; the assertions
 * (settles + fee 0 + balanced) stay the same.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Money, SourceFeeChannel } from '@app/shared';
import type { PrismaClient } from '@app/db';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterEach(() => {
  // Restore any spy so a forced failure can't leak into sibling tests/files.
  vi.restoreAllMocks();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

async function setIngestFeeRule(sourceId: string, feeValue: string): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.sourceFeeRule.createMany({
      data: [
        {
          sourceId,
          channel: SourceFeeChannel.INGEST,
          minAmount: '0',
          maxAmount: null,
          feeType: 'PERCENTAGE',
          feeValue,
        },
      ],
    }),
  );
}

/**
 * Wrap `runAsAdmin` so the closure receives a `tx` whose `sourceFeeRule.findMany`
 * throws, while every other delegate (incl. the ingest source/company lookup's
 * `source.findUnique` / `company.findUnique`) passes through to the real client.
 * This pinpoints the fee-schedule read inside `ingest` without disturbing the
 * surrounding admin reads.
 */
function breakSourceFeeFindMany(message: string): void {
  const real = h.prisma.runAsAdmin.bind(h.prisma);
  vi.spyOn(h.prisma, 'runAsAdmin').mockImplementation((fn, opts) =>
    real((tx) => {
      const proxied = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'sourceFeeRule') {
            const delegate = Reflect.get(target, prop, receiver) as PrismaClient['sourceFeeRule'];
            return new Proxy(delegate, {
              get(dTarget, dProp, dReceiver) {
                if (dProp === 'findMany') {
                  return () => Promise.reject(new Error(message));
                }
                return Reflect.get(dTarget, dProp, dReceiver);
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as PrismaClient;
      return fn(proxied);
    }, opts),
  );
}

describe('source-fee best-effort fallback (ingest)', () => {
  it('still settles the deposit with source_fee_amount=0 when the fee-rule fetch throws', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // platform earns 10% commission
    // A real INGEST schedule exists, so a HEALTHY fetch would freeze a nonzero
    // source fee (1% of 100 = 1). Forcing the fetch to throw must fall back to 0.
    await setIngestFeeRule(sourceId, '1');

    breakSourceFeeFindMany('injected: source_fee_rule read failed');

    // The deposit must NOT reject — the fee is a reporting figure, not a gate.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'ext-feefail-1' }),
    );
    expect(txn.replayed).toBe(false);
    // Commission still priced normally (10% deducted → net 90), independent of
    // the failed source-fee read.
    expect(eq(txn.netAmount, '90')).toBe(true);

    // source_fee_amount fell back to 0 (NOT the 1 a healthy fetch would freeze).
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({
        where: { id: txn.id },
        select: { sourceFeeAmount: true },
      }),
    );
    expect(eq(row!.sourceFeeAmount.toString(), '0')).toBe(true);

    // The money side is fully intact: ledger balanced, wallet == ledger.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.availableLedger, '90')).toBe(true);
    expect(eq(snap.wallet!.available, snap.availableLedger)).toBe(true);
  });

  it('control: with the fetch healthy the same deposit freezes the real fee', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await setIngestFeeRule(sourceId, '1'); // 1% INGEST

    // No spy here — proves the fallback above wasn't masking an always-0 path:
    // the identical deposit freezes the real 1% fee ($1) when the fetch works.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'ext-feeok-1' }),
    );
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({
        where: { id: txn.id },
        select: { sourceFeeAmount: true },
      }),
    );
    expect(eq(row!.sourceFeeAmount.toString(), '1')).toBe(true);
  });
});
