import { describe, expect, it } from 'vitest';
import type {
  ActivityItem,
  LoadResponse,
  TransactionDetailResponse,
  TransactionResponse,
  WithdrawalResponse,
} from '@app/shared';
import {
  backofficeActivityItem,
  backofficeCsvCells,
  backofficeList,
  backofficeLoad,
  backofficePayOut,
  backofficeTransaction,
  backofficeTransactionDetail,
  isBackoffice,
} from './backoffice-view';

/**
 * Back office must never learn what the platform charges: each view keeps ONE
 * money figure (what crossed the platform's boundary) and drops every field a
 * fee could be read or derived from.
 */
const FEE_KEYS = [
  'commissionAmount',
  'feeAmount',
  'networkFeeAmount',
  'fee',
  'networkFee',
  'feeApplication',
  'roundingRemainder',
];
const keysOf = (o: object) => Object.keys(o);

const deposit: TransactionResponse = {
  id: 't1',
  companyId: 'c1',
  sourceId: 's1',
  sourceCode: 'whish',
  externalTransactionId: 'e1',
  amount: '100',
  currency: 'USD',
  commissionAmount: '2',
  networkFeeAmount: '1',
  netAmount: '97',
  status: 'COMPLETED',
  customer: null,
  target: null,
  phone: null,
  note: null,
  processedAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
};

const withdrawal = {
  id: 'w1',
  companyId: 'c1',
  amount: '100',
  currency: 'USD',
  feeAmount: '2',
  networkFeeAmount: '1',
  feeApplication: 'ON_TOP',
  netAmount: '100',
  roundingRemainder: '0',
  totalAmount: '103',
  status: 'PENDING',
  payoutMethod: 'CASH',
  payoutDetails: null,
  externalReference: null,
  requestedById: null,
  approvedById: null,
  notes: null,
  adminNotes: null,
  processedAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
} as WithdrawalResponse;

const load = {
  id: 'l1',
  companyId: 'c1',
  amount: '100',
  currency: 'USD',
  feeAmount: '1',
  networkFeeAmount: '1',
  feeApplication: 'DEDUCTED',
  netAmount: '98',
  totalAmount: '100',
  status: 'PENDING',
  payoutMethod: 'CASH',
  payoutDetails: null,
  externalReference: null,
  requestedById: null,
  approvedById: null,
  notes: null,
  adminNotes: null,
  processedAt: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
} as LoadResponse;

describe('back-office views', () => {
  it('only BACKOFFICE gets the view', () => {
    expect(isBackoffice({ role: 'BACKOFFICE' })).toBe(true);
    for (const role of ['SUPER_ADMIN', 'ADMIN_OPERATOR', 'COMPANY_OWNER', undefined]) {
      expect(isBackoffice({ role })).toBe(false);
    }
  });

  it('deposit: only what the customer paid — even when it was priced ON_TOP', () => {
    const v = backofficeTransaction(deposit);
    expect(v.amount).toBe('100');
    for (const k of [...FEE_KEYS, 'netAmount']) expect(keysOf(v)).not.toContain(k);
    // ON_TOP deposit: stored amount is the net, the gross is net + fees.
    expect(backofficeTransaction({ ...deposit, amount: '97' }).amount).toBe('100');
  });

  it('deposit detail: no payload, no ledger legs', () => {
    const d: TransactionDetailResponse = {
      transaction: { ...deposit, payload: { gross: '100', fee: '3' }, idempotencyKey: null },
      ledgerEntries: [
        {
          id: 'x',
          accountType: 'EXTERNAL',
          direction: 'DEBIT',
          amount: '100',
          currency: 'USD',
          metadata: null,
          createdAt: '',
        },
      ],
    };
    const v = backofficeTransactionDetail(d);
    expect(v.ledgerEntries).toEqual([]);
    expect(v.transaction.payload).toBeNull();
    expect(keysOf(v.transaction)).not.toContain('netAmount');
  });

  it('withdrawal/payout: only what the recipient is paid', () => {
    const v = backofficePayOut(withdrawal);
    expect(v.netAmount).toBe('100');
    for (const k of [...FEE_KEYS, 'amount', 'totalAmount']) expect(keysOf(v)).not.toContain(k);
  });

  it('load: only what is collected', () => {
    const v = backofficeLoad(load);
    expect(v.totalAmount).toBe('100');
    for (const k of [...FEE_KEYS, 'amount', 'netAmount']) expect(keysOf(v)).not.toContain(k);
  });

  it('activity: one figure per kind, no running balance', () => {
    const base = {
      id: 'a',
      direction: 'OUT',
      currency: 'USD',
      description: 'CASH',
      details: null,
      reference: null,
      createdAt: '',
      completedAt: null,
      companyId: null,
      companyName: null,
      balanceAfter: '500',
    } as const;
    const out = backofficeActivityItem({
      ...base,
      kind: 'WITHDRAWAL',
      amount: '103',
      fee: '2',
      networkFee: '1',
      net: '100',
    } as ActivityItem);
    expect(out.amount).toBe('100');
    expect(out.balanceAfter).toBeNull();
    for (const k of ['fee', 'networkFee', 'net']) expect(keysOf(out)).not.toContain(k);
    const dep = backofficeActivityItem({
      ...base,
      direction: 'IN',
      kind: 'DEPOSIT',
      amount: '100',
      fee: '2',
      networkFee: '1',
      net: '97',
    } as ActivityItem);
    expect(dep.amount).toBe('100');
  });

  it('lists map every row and keep the paging meta', () => {
    const page = backofficeList(
      { data: [withdrawal], meta: { page: 1, total: 1 } },
      backofficePayOut,
    );
    expect(page.meta).toEqual({ page: 1, total: 1 });
    expect(keysOf(page.data[0]!)).not.toContain('feeAmount');
  });

  it('CSV: blanks hidden columns, keeps positions, applies overrides', () => {
    const header = ['id', 'gross_amount', 'fee_amount', 'net_amount', 'network_fee_amount'];
    expect(
      backofficeCsvCells(header, ['w1', '103.00', '2.00', '100.00', '1.00'], {
        hide: ['gross_amount', 'fee_amount', 'network_fee_amount'],
      }),
    ).toEqual(['w1', '', '', '100.00', '']);
    expect(
      backofficeCsvCells(['amount', 'net_amount'], ['97.00', '97.00'], {
        hide: ['net_amount'],
        overrides: { amount: '100.00' },
      }),
    ).toEqual(['100.00', '']);
  });
});
