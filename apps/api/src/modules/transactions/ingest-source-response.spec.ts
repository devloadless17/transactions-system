import { describe, expect, it } from 'vitest';
import type { TransactionResponse } from '@app/shared';
import { toSourceTransaction } from './ingest.controller';

/**
 * The source-facing ingest response is a fixed whitelist. A source (e.g. Whish)
 * must never see what Rival charges the company — neither fee, nor the net that
 * would reveal them — and never an internal UUID other than the transaction id.
 * Pinned with a transaction that DOES carry both fees, so a field added to
 * TransactionResponse can't silently start leaking.
 */
const charged: TransactionResponse = {
  id: '0f8d2c4e-1a2b-4c3d-9e8f-7a6b5c4d3e2f',
  companyId: '11111111-1111-1111-1111-111111111111',
  sourceId: '22222222-2222-2222-2222-222222222222',
  sourceCode: 'whish',
  externalTransactionId: 'ext-1',
  amount: '100',
  currency: 'USD',
  commissionAmount: '2',
  networkFeeAmount: '1',
  netAmount: '97',
  status: 'COMPLETED',
  refunded: false,
  refundedAt: null,
  customer: 'Jane Doe',
  target: 'ACC-1',
  phone: '+9610000000',
  note: 'note',
  processedAt: '2026-10-08T12:00:00.000Z',
  createdAt: '2026-10-08T12:00:00.000Z',
};

describe('toSourceTransaction (source-facing ingest response)', () => {
  it('exposes exactly the whitelisted fields', () => {
    expect(Object.keys(toSourceTransaction(charged, 'acme', false)).sort()).toEqual(
      [
        'amount',
        'companySlug',
        'createdAt',
        'currency',
        'customer',
        'externalTransactionId',
        'id',
        'note',
        'phone',
        'processedAt',
        'replayed',
        'sourceCode',
        'status',
        'tradingAccount',
      ].sort(),
    );
  });

  it('never carries a fee, the net, or an internal company/source id', () => {
    const body = toSourceTransaction(charged, 'acme', true) as Record<string, unknown>;
    for (const hidden of [
      'commissionAmount',
      'networkFeeAmount',
      'netAmount',
      'companyId',
      'sourceId',
    ]) {
      expect(body).not.toHaveProperty(hidden);
    }
    expect(body.amount).toBe('100'); // the gross the source sent, nothing else
  });
});
