import { describe, expect, it } from 'vitest';
import { FLOW_CSV_HEADER, flowCsvCells, type FlowCsvRow } from './flow-csv';

/**
 * The withdrawals / payouts / loads CSV is parsed by companies' own tooling, so
 * column POSITIONS are a contract: new columns are only ever appended. Pins the
 * full header and that the money cells tie out (gross = fee + network fee + net).
 */
const dec = (s: string) => ({ toString: () => s });

const row = (over: Partial<FlowCsvRow> = {}): FlowCsvRow => ({
  id: 'w-1',
  companyId: 'co-1',
  amount: dec('100'),
  currency: 'USD',
  feeAmount: dec('2'),
  networkFeeAmount: dec('1'),
  netAmount: dec('100'),
  feeApplication: 'ON_TOP',
  status: 'COMPLETED',
  payoutMethod: 'CASH',
  payoutDetails: { method: 'CASH', recipientName: 'Payee', recipientPhone: '+9610000000' },
  externalReference: 'ref-1',
  notes: null,
  adminNotes: null,
  processedAt: new Date('2026-10-08T12:00:00Z'),
  createdAt: new Date('2026-10-08T11:00:00Z'),
  ...over,
});

describe('flow CSV', () => {
  it('keeps every existing column position and appends network_fee_amount last', () => {
    expect([...FLOW_CSV_HEADER]).toEqual([
      'id',
      'created_at',
      'processed_at',
      'company_id',
      'status',
      'currency',
      'gross_amount',
      'fee_amount',
      'net_amount',
      'fee_application',
      'payout_method',
      'external_reference',
      'recipient_name',
      'recipient_contact',
      'notes',
      'admin_notes',
      'network_fee_amount',
    ]);
  });

  it('one cell per column; gross = fee + network fee + net', () => {
    const cells = flowCsvCells(row());
    expect(cells).toHaveLength(FLOW_CSV_HEADER.length);
    const at = (name: (typeof FLOW_CSV_HEADER)[number]) => cells[FLOW_CSV_HEADER.indexOf(name)];
    expect(at('gross_amount')).toBe('103.00');
    expect(at('fee_amount')).toBe('2.00');
    expect(at('network_fee_amount')).toBe('1.00');
    expect(at('net_amount')).toBe('100.00');
  });

  it('a company not charged a network fee exports 0.00 and an unchanged gross', () => {
    const cells = flowCsvCells(
      row({ networkFeeAmount: dec('0'), feeApplication: 'DEDUCTED', netAmount: dec('98') }),
    );
    const at = (name: (typeof FLOW_CSV_HEADER)[number]) => cells[FLOW_CSV_HEADER.indexOf(name)];
    expect(at('gross_amount')).toBe('100.00');
    expect(at('network_fee_amount')).toBe('0.00');
  });
});
