import { describe, expect, it } from 'vitest';
import type {
  ActivityItem,
  LoadResponse,
  TransactionDetailResponse,
  TransactionResponse,
  WhishPaymentResponse,
  WithdrawalResponse,
} from '@app/shared';
import { ACTIVITY_CSV_HEADER } from '../modules/activity/activity.service';
import { TRANSACTIONS_CSV_HEADER } from '../modules/transactions/transactions.service';
import { FLOW_CSV_HEADER } from './flow-csv';
import {
  BACKOFFICE_CSV_COLUMNS,
  BACKOFFICE_SETTLEMENT_ERROR,
  backofficeActivityItem,
  backofficeCsvCells,
  backofficeList,
  backofficeLoad,
  backofficePayOut,
  backofficeTransaction,
  backofficeTransactionDetail,
  backofficeWhishPayment,
  isBackoffice,
} from './backoffice-view';

/**
 * Back office must never learn what the platform charges: each view keeps ONE
 * money figure (what crossed the platform's boundary) and drops every field a
 * fee could be read or derived from.
 *
 * The views are ALLOW-lists, so each test pins the EXACT set of keys back office
 * receives: a field that leaks through later fails here, not in production.
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

  it('deposit: exactly these fields — the amount the customer paid and no split', () => {
    const v = backofficeTransaction(deposit);
    expect(keysOf(v).sort()).toEqual(
      [
        'amount',
        'companyId',
        'createdAt',
        'currency',
        'customer',
        'externalTransactionId',
        'id',
        'note',
        'phone',
        'processedAt',
        'sourceCode',
        'sourceId',
        'status',
        'target',
      ].sort(),
    );
    expect(v.amount).toBe('100');
    for (const k of [...FEE_KEYS, 'netAmount']) expect(keysOf(v)).not.toContain(k);
  });

  it('deposit priced ON_TOP: still the amount the customer paid, never amount + fees', () => {
    // $100 paid, 2 commission + 1 network fee charged ON TOP: the wallet is
    // credited the full 100 and the ledger books 103. Back office can read the
    // paid 100 on the Whish pages, so showing 103 here would hand them the fee.
    const onTop: TransactionResponse = { ...deposit, amount: '100', netAmount: '100' };
    expect(backofficeTransaction(onTop).amount).toBe('100');
  });

  it('a field added to a response later is hidden from back office by default', () => {
    const withExtra = { ...deposit, walletCreditAmount: '97' } as TransactionResponse;
    expect(keysOf(backofficeTransaction(withExtra))).not.toContain('walletCreditAmount');
    const wExtra = { ...withdrawal, walletDebitAmount: '103' } as WithdrawalResponse;
    expect(keysOf(backofficePayOut(wExtra))).not.toContain('walletDebitAmount');
    const lExtra = { ...load, walletCreditAmount: '98' } as LoadResponse;
    expect(keysOf(backofficeLoad(lExtra))).not.toContain('walletCreditAmount');
  });

  it("an admin deposit row's Whish payment link never reaches back office (it can't refund)", () => {
    const adminRow = { ...deposit, whishPayment: { id: 'wp-1', status: 'PAID' } };
    expect(keysOf(backofficeTransaction(adminRow))).not.toContain('whishPayment');
  });

  it('deposit detail: no payload, no ledger legs — but the idempotency key stays', () => {
    const d: TransactionDetailResponse = {
      transaction: { ...deposit, payload: { gross: '100', fee: '3' }, idempotencyKey: 'idem-1' },
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
    expect(v.transaction.idempotencyKey).toBe('idem-1');
    expect(keysOf(v.transaction)).not.toContain('netAmount');
  });

  it('withdrawal/payout: exactly these fields — only what the recipient is paid', () => {
    const v = backofficePayOut(withdrawal);
    expect(keysOf(v).sort()).toEqual(
      [
        'adminNotes',
        'approvedById',
        'companyId',
        'createdAt',
        'currency',
        'externalReference',
        'id',
        'netAmount',
        'notes',
        'payoutDetails',
        'payoutMethod',
        'processedAt',
        'requestedById',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(v.netAmount).toBe('100');
    for (const k of [...FEE_KEYS, 'amount', 'totalAmount']) expect(keysOf(v)).not.toContain(k);
  });

  it('withdrawal: keeps the auto-approval summary the queue needs', () => {
    const v = backofficePayOut({
      ...withdrawal,
      autoApproval: { status: 'failed', terminal: true },
    } as WithdrawalResponse);
    expect(v.autoApproval).toEqual({ status: 'failed', terminal: true });
  });

  it('load: exactly these fields — only what is collected', () => {
    const v = backofficeLoad(load);
    expect(keysOf(v).sort()).toEqual(
      [
        'adminNotes',
        'approvedById',
        'companyId',
        'createdAt',
        'currency',
        'externalReference',
        'id',
        'notes',
        'payoutDetails',
        'payoutMethod',
        'processedAt',
        'requestedById',
        'status',
        'totalAmount',
        'updatedAt',
      ].sort(),
    );
    expect(v.totalAmount).toBe('100');
    for (const k of [...FEE_KEYS, 'amount', 'netAmount']) expect(keysOf(v)).not.toContain(k);
  });

  it('activity: one figure per direction, no running balance', () => {
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
    for (const kind of ['WITHDRAWAL', 'PAYOUT'] as const) {
      const out = backofficeActivityItem({
        ...base,
        kind,
        amount: '103',
        fee: '2',
        networkFee: '1',
        net: '100',
      } as ActivityItem);
      // Money paid out: the net (what the recipient is paid).
      expect(out.amount).toBe('100');
      expect(out.balanceAfter).toBeNull();
      expect(keysOf(out).sort()).toEqual(
        [
          'amount',
          'balanceAfter',
          'companyId',
          'companyName',
          'completedAt',
          'createdAt',
          'currency',
          'description',
          'details',
          'direction',
          'id',
          'kind',
          'reference',
        ].sort(),
      );
    }
    for (const kind of ['DEPOSIT', 'LOAD'] as const) {
      const moneyIn = backofficeActivityItem({
        ...base,
        direction: 'IN',
        kind,
        amount: '100',
        fee: '2',
        networkFee: '1',
        net: '97',
      } as ActivityItem);
      // Money in: the item's amount, which the feed builds for back office (the
      // paid amount for a deposit, the collected total for a load).
      expect(moneyIn.amount).toBe('100');
      for (const k of ['fee', 'networkFee', 'net']) expect(keysOf(moneyIn)).not.toContain(k);
    }
  });

  describe('Whish payment', () => {
    const payment: WhishPaymentResponse = {
      id: 'p1',
      companyId: 'c1',
      externalId: '7000000001',
      status: 'PENDING',
      amount: '3',
      currency: 'USD',
      invoice: 'inv 7',
      collectUrl: 'https://whish.example/pay/1',
      payerPhoneNumber: null,
      transactionId: null,
      needsAttention: false,
      settlementError: null,
      createdAt: '2026-10-08T00:00:00.000Z',
      paidAt: null,
      refundedAt: null,
    };

    it('a healthy payment passes through with the amount the payer pays', () => {
      expect(backofficeWhishPayment(payment)).toEqual(payment);
    });

    it('a settlement failure reason is replaced — it can spell out the commission', () => {
      // The real reason of a strict WHISH_PAY settlement that hit a mispriced rule.
      const stuck: WhishPaymentResponse = {
        ...payment,
        needsAttention: true,
        settlementError:
          'Resolved commission (5) exceeds the amount (3) for a DEDUCTED fee (rule=9d2f). Fix the commission rule.',
      };
      const v = backofficeWhishPayment(stuck);
      expect(v.needsAttention).toBe(true);
      expect(v.settlementError).toBe(BACKOFFICE_SETTLEMENT_ERROR);
      expect(JSON.stringify(v)).not.toMatch(/commission|rule=|\(5\)/i);
      // Everything else is untouched.
      expect({ ...v, settlementError: stuck.settlementError }).toEqual(stuck);
    });

    it('a field added to the payment later is hidden from back office by default', () => {
      const withExtra = { ...payment, feePreview: '0.06' } as WhishPaymentResponse;
      expect(keysOf(backofficeWhishPayment(withExtra))).not.toContain('feePreview');
    });
  });

  it('lists map every row and keep the paging meta', () => {
    const page = backofficeList(
      { data: [withdrawal], meta: { page: 1, total: 1 } },
      backofficePayOut,
    );
    expect(page.meta).toEqual({ page: 1, total: 1 });
    expect(keysOf(page.data[0]!)).not.toContain('feeAmount');
  });

  describe('CSV exports', () => {
    it('keeps only the listed columns, in place — an unlisted column is blank', () => {
      const header = ['id', 'gross_amount', 'fee_amount', 'net_amount', 'network_fee_amount'];
      expect(
        backofficeCsvCells(
          header,
          ['w1', '103.00', '2.00', '100.00', '1.00'],
          ['id', 'net_amount'],
        ),
      ).toEqual(['w1', '', '', '100.00', '']);
      // A column appended to an export later is hidden until it is listed.
      expect(
        backofficeCsvCells(
          [...header, 'wallet_debit'],
          ['w1', '', '', '100.00', '', '103.00'],
          ['id', 'net_amount'],
        ),
      ).toEqual(['w1', '', '', '100.00', '', '']);
    });

    // For each export: what back office does NOT get is exactly the fee columns
    // and the other side of the split. Adding a column to a header makes it
    // hidden — and fails here until it is deliberately classified.
    const hidden = (header: ReadonlyArray<string>, show: ReadonlyArray<string>) =>
      header.filter((c) => !show.includes(c));
    const unknown = (header: ReadonlyArray<string>, show: ReadonlyArray<string>) =>
      show.filter((c) => !header.includes(c));

    it('deposits: only `amount`', () => {
      const show = BACKOFFICE_CSV_COLUMNS.deposits;
      expect(unknown(TRANSACTIONS_CSV_HEADER, show)).toEqual([]);
      expect(hidden(TRANSACTIONS_CSV_HEADER, show)).toEqual([
        'commission_amount',
        'net_amount',
        'network_fee_amount',
      ]);
    });

    it('withdrawals / payouts: only `net_amount`; loads: only `gross_amount`', () => {
      const { pay, collect } = BACKOFFICE_CSV_COLUMNS.flow;
      expect(unknown(FLOW_CSV_HEADER, pay)).toEqual([]);
      expect(unknown(FLOW_CSV_HEADER, collect)).toEqual([]);
      expect(hidden(FLOW_CSV_HEADER, pay)).toEqual([
        'gross_amount',
        'fee_amount',
        'fee_application',
        'network_fee_amount',
      ]);
      expect(hidden(FLOW_CSV_HEADER, collect)).toEqual([
        'fee_amount',
        'net_amount',
        'fee_application',
        'network_fee_amount',
      ]);
    });

    it('activity: `gross_amount` for money in, `net_amount` for money paid out', () => {
      const { in: moneyIn, out } = BACKOFFICE_CSV_COLUMNS.activity;
      expect(unknown(ACTIVITY_CSV_HEADER, moneyIn)).toEqual([]);
      expect(unknown(ACTIVITY_CSV_HEADER, out)).toEqual([]);
      expect(hidden(ACTIVITY_CSV_HEADER, moneyIn)).toEqual([
        'fee_amount',
        'net_amount',
        'fee_application',
        'network_fee_amount',
      ]);
      expect(hidden(ACTIVITY_CSV_HEADER, out)).toEqual([
        'gross_amount',
        'fee_amount',
        'fee_application',
        'network_fee_amount',
      ]);
    });
  });
});
