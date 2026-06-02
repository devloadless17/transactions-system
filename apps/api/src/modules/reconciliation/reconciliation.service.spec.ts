import { describe, expect, it } from 'vitest';
import {
  buildReconciliationReport,
  foldReceivables,
  type LedgerSumRow,
  type WalletRow,
} from './reconciliation.service';

const co = '11111111-1111-1111-1111-111111111111';
const AT = '2026-06-02T00:00:00.000Z';

function led(partial: Partial<LedgerSumRow>): LedgerSumRow {
  return {
    companyId: partial.companyId ?? co,
    currency: partial.currency ?? 'USD',
    accountType: partial.accountType ?? 'AVAILABLE',
    direction: partial.direction ?? 'CREDIT',
    sum: partial.sum ?? '0',
  };
}

function wallet(partial: Partial<WalletRow>): WalletRow {
  return {
    companyId: partial.companyId ?? co,
    currency: partial.currency ?? 'USD',
    availableBalance: partial.availableBalance ?? '0',
    pendingBalance: partial.pendingBalance ?? '0',
    reservedBalance: partial.reservedBalance ?? '0',
  };
}

describe('buildReconciliationReport', () => {
  it('reports no discrepancy for a balanced ingest (FEE/EXTERNAL ignored)', () => {
    const ledger = [
      led({ accountType: 'EXTERNAL', direction: 'DEBIT', sum: '100' }),
      led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '98' }),
      led({ accountType: 'FEE', direction: 'CREDIT', sum: '2' }),
    ];
    const wallets = [wallet({ availableBalance: '98' })];
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(0);
    expect(report.walletsChecked).toBe(1);
    expect(report.checkedAt).toBe(AT);
  });

  it('detects an available-balance divergence and reports the signed delta', () => {
    const ledger = [led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '98' })];
    const wallets = [wallet({ availableBalance: '98.01' })]; // wallet ahead of ledger by a cent
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(1);
    const d = report.discrepancies[0]!;
    expect(d.walletExists).toBe(true);
    expect(d.available.wallet).toBe('98.01');
    expect(d.available.ledger).toBe('98');
    expect(d.available.delta).toBe('0.01');
  });

  it('flags ledger entries with no wallet row (walletExists=false)', () => {
    const ledger = [led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '50' })];
    const report = buildReconciliationReport(ledger, [], AT);
    expect(report.divergentCount).toBe(1);
    const d = report.discrepancies[0]!;
    expect(d.walletExists).toBe(false);
    expect(d.available.wallet).toBe('0');
    expect(d.available.ledger).toBe('50');
    expect(d.available.delta).toBe('-50');
  });

  it('balances a reserve move (available→reserved) across multiple ledger lines', () => {
    const ledger = [
      led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '100' }), // initial credit
      led({ accountType: 'AVAILABLE', direction: 'DEBIT', sum: '100' }), // reserved out
      led({ accountType: 'RESERVED', direction: 'CREDIT', sum: '100' }),
    ];
    const wallets = [wallet({ availableBalance: '0', reservedBalance: '100' })];
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(0);
  });

  it('matches across blank-padded CHAR(3) currency on either side', () => {
    const ledger = [
      led({ currency: 'USD', accountType: 'AVAILABLE', direction: 'CREDIT', sum: '10' }),
    ];
    const wallets = [wallet({ currency: 'USD ', availableBalance: '10' })]; // padded
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(0);
    expect(report.walletsChecked).toBe(1);
  });

  it('isolates discrepancies per company+currency', () => {
    const other = '22222222-2222-2222-2222-222222222222';
    const ledger = [
      led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '10' }),
      led({ companyId: other, accountType: 'AVAILABLE', direction: 'CREDIT', sum: '20' }),
    ];
    const wallets = [
      wallet({ availableBalance: '10' }), // matches
      wallet({ companyId: other, availableBalance: '15' }), // off by 5
    ];
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(1);
    expect(report.discrepancies[0]!.companyId).toBe(other);
    expect(report.discrepancies[0]!.available.delta).toBe('-5');
  });

  it('does not treat a RECEIVABLE entry as a wallet divergence', () => {
    // A reversal that drained available to 0 and booked the rest to RECEIVABLE.
    const ledger = [
      led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '10' }),
      led({ accountType: 'AVAILABLE', direction: 'DEBIT', sum: '10' }),
      led({ accountType: 'RECEIVABLE', direction: 'DEBIT', sum: '88' }),
    ];
    const wallets = [wallet({ availableBalance: '0' })];
    const report = buildReconciliationReport(ledger, wallets, AT);
    expect(report.divergentCount).toBe(0);
    expect(report.receivables).toEqual([{ companyId: co, currency: 'USD', outstanding: '88' }]);
  });
});

describe('foldReceivables', () => {
  it('returns debit-normal outstanding per company+currency, omitting zeros', () => {
    const other = '22222222-2222-2222-2222-222222222222';
    const rows: LedgerSumRow[] = [
      led({ accountType: 'RECEIVABLE', direction: 'DEBIT', sum: '88' }),
      led({ accountType: 'RECEIVABLE', direction: 'CREDIT', sum: '8' }), // partial repayment
      led({ companyId: other, accountType: 'RECEIVABLE', direction: 'DEBIT', sum: '50' }),
      led({ companyId: other, accountType: 'RECEIVABLE', direction: 'CREDIT', sum: '50' }), // fully repaid → omitted
      led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '999' }), // ignored
    ];
    const result = foldReceivables(rows);
    expect(result).toEqual([{ companyId: co, currency: 'USD', outstanding: '80' }]);
  });

  it('returns empty when there are no receivable lines', () => {
    expect(
      foldReceivables([led({ accountType: 'AVAILABLE', direction: 'CREDIT', sum: '5' })]),
    ).toEqual([]);
  });
});
