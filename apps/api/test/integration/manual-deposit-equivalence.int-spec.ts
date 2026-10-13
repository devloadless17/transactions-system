import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createManualDepositSchema, Money } from '@app/shared';
import {
  IngestController,
  ingestSourceTransactionSchema,
} from '../../src/modules/transactions/ingest.controller';
import { AdminDepositsController } from '../../src/modules/transactions/admin-deposits.controller';
import type { AuthenticatedRequest } from '../../src/common/types/request.types';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  setNetworkFee,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * The promise of the manual deposit form: a deposit entered by hand is EXACTLY
 * the deposit the source would have booked by sending it through its API key
 * to POST /v1/ingest/:source/transactions.
 *
 * Proven here with the same deposit sent through BOTH real request handlers —
 * the source-facing IngestController (slug resolution, tradingAccount→target,
 * the source's own body schema) and the admin AdminDepositsController — then
 * comparing every column of the stored transaction, every ledger line, the
 * wallet credit, the source fee, and the CRM event the company receives. Only
 * the row id, the reference and the timestamps may differ.
 *
 * (The guards in front of each handler — source API key vs. super-admin
 * session — decide WHO may book, never WHAT is booked.)
 */
describe('Manual deposit ≡ the source API deposit', () => {
  let h: Harness;
  beforeAll(() => {
    h = buildHarness();
  });
  beforeEach(() => h.crm.reset());

  /** A company priced like production: 2% fee, 1% network fee, and a source that charges us 1%. */
  async function setup() {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '2');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const { slug, sourceCode } = await h.prisma.runAsAdmin(async (tx) => {
      await tx.sourceFeeRule.create({
        data: {
          sourceId,
          channel: 'INGEST',
          minAmount: '0',
          maxAmount: null,
          feeType: 'PERCENTAGE',
          feeValue: '1',
        },
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const source = await tx.source.findUniqueOrThrow({ where: { id: sourceId } });
      return { slug: company.slug, sourceCode: source.code };
    });
    const api = new IngestController(h.transactions, h.prisma);
    const form = new AdminDepositsController(h.transactions);
    // What the source's API key resolves to — the guard's only output.
    const sourceRequest = () => ({ principal: { sourceId } }) as unknown as AuthenticatedRequest;
    return { companyId, sourceId, slug, sourceCode, api, form, sourceRequest };
  }

  // The descriptive fields, as the source sends them and as the form takes them.
  const details = { customer: 'Jane Payer', phone: '+96170000000', note: 'Deposit at branch 4' };

  /** Everything stored for a deposit except its id, reference and timestamps. */
  async function storedDeposit(h: Harness, transactionId: string) {
    return h.prisma.runAsAdmin(async (tx) => {
      const t = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      const legs = await tx.ledgerEntry.findMany({ where: { transactionId } });
      return {
        row: {
          companyId: t.companyId,
          sourceId: t.sourceId,
          amount: Money.fromDb(t.amount).toFixed(2),
          currency: t.currency,
          commissionAmount: Money.fromDb(t.commissionAmount).toFixed(2),
          networkFeeAmount: Money.fromDb(t.networkFeeAmount).toFixed(2),
          netAmount: Money.fromDb(t.netAmount).toFixed(2),
          sourceFeeAmount: Money.fromDb(t.sourceFeeAmount).toFixed(2),
          status: t.status,
          pricingIssue: t.pricingIssue,
          payload: t.payload,
          idempotencyKey: t.idempotencyKey,
          processedAtSet: t.processedAt !== null,
        },
        legs: legs
          .map(
            (l) =>
              `${l.direction} ${l.accountType} ${Money.fromDb(l.amount).toFixed(2)} ${l.currency} ${l.companyId}`,
          )
          .sort(),
      };
    });
  }

  it('books the identical transaction, ledger lines, source fee and wallet credit', async () => {
    const { companyId, sourceCode, slug, api, form, sourceId, sourceRequest } = await setup();
    const before = await snapshot(h, companyId);

    const viaApi = await api.ingest(
      sourceCode,
      ingestSourceTransactionSchema.parse({
        companySlug: slug,
        externalTransactionId: 'EQ-API-1',
        amount: '250.00',
        currency: USD,
        payload: { ...details, tradingAccount: 'MT5-77' },
      }),
      sourceRequest(),
    );
    const viaForm = await form.create(
      createManualDepositSchema.parse({
        sourceId,
        companyId,
        externalTransactionId: 'EQ-FORM-1',
        amount: '250.00',
        currency: USD,
        ...details,
        target: 'MT5-77',
      }),
    );

    const a = await storedDeposit(h, viaApi.id);
    const b = await storedDeposit(h, viaForm.id);
    expect(b.row).toEqual(a.row);
    expect(b.legs).toEqual(a.legs);
    // Priced for real (not a zero-fee coincidence): 2% + 1% network, 1% source cost.
    expect(a.row).toMatchObject({
      commissionAmount: '5.00',
      networkFeeAmount: '2.50',
      netAmount: '242.50',
      sourceFeeAmount: '2.50',
      status: 'COMPLETED',
      pricingIssue: null,
    });
    // The trading account a source sends as `tradingAccount` is stored the same.
    expect(b.row.payload).toEqual({ ...details, target: 'MT5-77' });

    // Each credited the company the same net.
    const after = await snapshot(h, companyId);
    expect(
      Money.of(after.wallet!.available)
        .sub(Money.of(before.wallet?.available ?? '0'))
        .toFixed(2),
    ).toBe('485.00');
    expect(after.balanced).toBe(true);
  });

  it("sends the company's CRM the identical transaction.completed event", async () => {
    const { companyId, sourceCode, slug, api, form, sourceId, sourceRequest } = await setup();

    await api.ingest(
      sourceCode,
      ingestSourceTransactionSchema.parse({
        companySlug: slug,
        externalTransactionId: 'EQ-API-2',
        amount: '80.00',
        currency: USD,
        payload: { ...details, tradingAccount: 'MT5-88' },
      }),
      sourceRequest(),
    );
    await form.create(
      createManualDepositSchema.parse({
        sourceId,
        companyId,
        externalTransactionId: 'EQ-FORM-2',
        amount: '80.00',
        currency: USD,
        ...details,
        target: 'MT5-88',
      }),
    );

    expect(h.crm.names()).toEqual(['transaction.completed', 'transaction.completed']);
    const strip = (p: Record<string, unknown>) => {
      const { id: _id, externalTransactionId: _ref, createdAt: _c, processedAt: _p, ...rest } = p;
      return rest;
    };
    const [fromApi, fromForm] = h.crm.events.map((e) => strip(e.payload));
    expect(fromForm).toEqual(fromApi);
  });

  it('the same deposit, sent later by the source through its API, is recognised — never a second credit', async () => {
    const { companyId, sourceCode, slug, api, form, sourceId, sourceRequest } = await setup();
    const booked = await form.create(
      createManualDepositSchema.parse({
        sourceId,
        companyId,
        externalTransactionId: 'WH-778899',
        amount: '120.00',
        currency: USD,
        ...details,
      }),
    );
    h.crm.reset();
    const before = await snapshot(h, companyId);

    const resent = await api.ingest(
      sourceCode,
      ingestSourceTransactionSchema.parse({
        companySlug: slug,
        externalTransactionId: 'WH-778899',
        amount: '120',
        currency: USD,
        payload: details,
      }),
      sourceRequest(),
    );

    expect(resent).toMatchObject({ id: booked.id, replayed: true });
    const after = await snapshot(h, companyId);
    expect(after.wallet?.available).toBe(before.wallet?.available);
    expect(after.totalCredit).toBe(before.totalCredit);
    expect(h.crm.names()).toEqual([]);
  });
});
