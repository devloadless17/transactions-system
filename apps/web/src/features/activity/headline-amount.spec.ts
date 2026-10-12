import { describe, expect, it } from 'vitest';
import { formatAmount } from '@/lib/format';
import { backofficeFlowAmount } from './headline-amount';

/**
 * Back office is sent ONE money field per record (common/backoffice-view.ts):
 * `totalAmount` on a load, `netAmount` on a withdrawal or payout. Those are the
 * shapes the detail drawer really receives, so the figure it shows has to come
 * out of each of them — and must never be the "—" of a missing value while the
 * record carries a figure.
 */

// As the API returns them to BACKOFFICE.
const BO_LOAD = { totalAmount: '103.00' };
const BO_PAYOUT = { netAmount: '97.00' };
// As everyone else gets them: both figures present.
const FULL_LOAD = { totalAmount: '103.00', netAmount: '100.00' };
const FULL_WITHDRAWAL = { totalAmount: '100.00', netAmount: '97.00' };

describe('backofficeFlowAmount', () => {
  it('shows what is collected for a load', () => {
    expect(backofficeFlowAmount(BO_LOAD, true)).toBe('103.00');
  });

  it('shows what the recipient is paid for a withdrawal or payout', () => {
    expect(backofficeFlowAmount(BO_PAYOUT, false)).toBe('97.00');
  });

  it('prefers the figure of its kind when a record carries both', () => {
    expect(backofficeFlowAmount(FULL_LOAD, true)).toBe('103.00');
    expect(backofficeFlowAmount(FULL_WITHDRAWAL, false)).toBe('97.00');
  });

  it("falls back to the record's own figure when the kind does not match it", () => {
    // A load's record read as a withdrawal (and the reverse): picking the field
    // by kind alone reads the one the API stripped, which rendered "Amount —".
    expect(backofficeFlowAmount(BO_LOAD, false)).toBe('103.00');
    expect(backofficeFlowAmount(BO_PAYOUT, true)).toBe('97.00');
  });

  it('treats a null field like a missing one', () => {
    expect(backofficeFlowAmount({ totalAmount: null, netAmount: '97.00' }, true)).toBe('97.00');
    expect(backofficeFlowAmount({ totalAmount: '103.00', netAmount: null }, false)).toBe('103.00');
  });

  it('never formats to "—" while the record has a figure', () => {
    for (const record of [BO_LOAD, BO_PAYOUT, FULL_LOAD, FULL_WITHDRAWAL]) {
      for (const isLoad of [true, false]) {
        expect(formatAmount(backofficeFlowAmount(record, isLoad))).not.toBe('—');
      }
    }
  });

  it('is empty only for a record with no figure at all', () => {
    expect(backofficeFlowAmount({}, true)).toBeUndefined();
    expect(backofficeFlowAmount({}, false)).toBeUndefined();
  });
});
