import { describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import { LedgerService, type LedgerEntryInput } from './ledger.service';

// LedgerService.writeEntries() takes a PrismaClient — for unit testing we
// don't care about the persistence layer, only the validation logic before
// it dispatches to the DB. We pass a mock client that records what was
// requested.

interface MockTx {
  ledgerEntry: { createMany: (args: { data: unknown[] }) => Promise<{ count: number }> };
  inserted: unknown[];
}

function mockTx(): MockTx {
  const inserted: unknown[] = [];
  return {
    inserted,
    ledgerEntry: {
      createMany: async ({ data }) => {
        inserted.push(...data);
        return { count: data.length };
      },
    },
  };
}

const COMPANY = '11111111-1111-1111-1111-111111111111';
const TX = '22222222-2222-2222-2222-222222222222';

// Cast helper: LedgerService.writeEntries expects PrismaClient but only uses
// the .ledgerEntry.createMany surface, so we type-erase the mock.
const writeWithMock = async (svc: LedgerService, entries: LedgerEntryInput[]) => {
  const tx = mockTx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await svc.writeEntries(tx as any, entries);
  return tx.inserted;
};

describe('LedgerService.writeEntries', () => {
  // The service's constructor args (PrismaService, CacheService) are only used
  // by listByCompany/exportCsv — not exercised by writeEntries. We can
  // instantiate with undefined/cast services.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new LedgerService(undefined as any, undefined as any);

  it('writes a balanced 2-leg entry (USD)', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
    ];
    const inserted = await writeWithMock(svc, entries);
    expect(inserted).toHaveLength(2);
  });

  it('writes a balanced 3-leg ingestion entry (with FEE)', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        transactionId: TX,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('200'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        transactionId: TX,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('195'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        transactionId: TX,
        accountType: 'FEE',
        direction: 'CREDIT',
        amount: Money.of('5'),
        currency: 'USD',
      },
    ];
    const inserted = await writeWithMock(svc, entries);
    expect(inserted).toHaveLength(3);
  });

  it('rejects unbalanced entries (debits != credits)', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('99'),
        currency: 'USD',
      },
    ];
    await expect(writeWithMock(svc, entries)).rejects.toThrow(/unbalanced/);
  });

  it('rejects zero-amount entries', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.zero(),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.zero(),
        currency: 'USD',
      },
    ];
    await expect(writeWithMock(svc, entries)).rejects.toThrow(/must be positive/);
  });

  it('rejects negative-amount entries', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('100').mul(-1),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('100').mul(-1),
        currency: 'USD',
      },
    ];
    await expect(writeWithMock(svc, entries)).rejects.toThrow(/must be positive/);
  });

  it('balances each currency independently', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('50'),
        currency: 'EUR',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('50'),
        currency: 'EUR',
      },
    ];
    const inserted = await writeWithMock(svc, entries);
    expect(inserted).toHaveLength(4);
  });

  it('rejects when one currency balances but another does not', async () => {
    const entries: LedgerEntryInput[] = [
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'AVAILABLE',
        direction: 'CREDIT',
        amount: Money.of('100'),
        currency: 'USD',
      },
      {
        companyId: COMPANY,
        accountType: 'EXTERNAL',
        direction: 'DEBIT',
        amount: Money.of('50'),
        currency: 'EUR',
      },
      // Missing the EUR credit leg.
    ];
    await expect(writeWithMock(svc, entries)).rejects.toThrow(/unbalanced.*EUR/);
  });

  it('no-ops on an empty entry list', async () => {
    const inserted = await writeWithMock(svc, []);
    expect(inserted).toHaveLength(0);
  });
});
