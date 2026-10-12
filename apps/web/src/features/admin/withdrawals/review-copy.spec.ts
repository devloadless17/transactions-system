import { describe, expect, it } from 'vitest';
import { reviewDescription, reviewDoneMessage, type ReviewAction } from './review-copy';

/**
 * What the review dialog tells an operator to do with real money, per role.
 * The BACKOFFICE rows below are shaped exactly as the API returns them — one
 * figure per kind, the rest stripped (common/backoffice-view.ts) — so these fail
 * if its copy ever again reads a stripped field ("— USD") or lets on that a fee
 * exists. The full-admin sentences are pinned word for word.
 */

// A load of 100 with a 2 commission + 1 network fee on top: 103 is collected.
const LOAD = { totalAmount: '103', netAmount: '100', currency: 'USD' };
// A payout of 100 with a 3 fee deducted: the recipient is paid 97.
const PAYOUT = { totalAmount: '100', netAmount: '97', currency: 'USD' };
// The same two rows as BACKOFFICE receives them.
const BO_LOAD = { totalAmount: '103', currency: 'USD' };
const BO_PAYOUT = { netAmount: '97', currency: 'USD' };

const admin = (
  action: ReviewAction,
  isLoad: boolean,
  withdrawal: typeof LOAD,
  hasNetworkFee = false,
) => reviewDescription({ action, isLoad, backoffice: false, hasNetworkFee, withdrawal });

const backoffice = (
  action: ReviewAction,
  isLoad: boolean,
  withdrawal: typeof BO_LOAD | typeof BO_PAYOUT,
  hasNetworkFee = false,
) => reviewDescription({ action, isLoad, backoffice: true, hasNetworkFee, withdrawal });

describe('reviewDescription — full admins', () => {
  it('approve a load: collect the gross, credit the net', () => {
    expect(admin('approve', true, LOAD)).toBe(
      'Confirm you received 103.00 USD (fee included) from the company, then approve to credit their wallet with 100.00 USD.',
    );
  });

  it('approve a withdrawal or payout: pay the net', () => {
    expect(admin('approve', false, PAYOUT)).toBe(
      'Pay the recipient 97.00 USD out-of-band (the fee is already deducted), then record the reference here.',
    );
  });

  it('names both fees once a network fee was charged', () => {
    expect(admin('approve', true, LOAD, true)).toContain('(fees included)');
    expect(admin('approve', false, PAYOUT, true)).toContain('(the fees are already deducted)');
  });

  it('reject: the reserved total is released', () => {
    expect(admin('reject', false, PAYOUT)).toBe('Reserved 100.00 USD returns to available.');
    expect(admin('reject', true, LOAD)).toBe('Reserved 103.00 USD returns to available.');
  });
});

describe('reviewDescription — back office', () => {
  it('approve a load: the amount to collect, and nothing else', () => {
    expect(backoffice('approve', true, BO_LOAD)).toBe(
      'Confirm you received 103.00 USD from the company, then approve to credit their wallet.',
    );
  });

  it('approve a withdrawal or payout: the amount to pay, and nothing else', () => {
    expect(backoffice('approve', false, BO_PAYOUT)).toBe(
      'Pay the recipient 97.00 USD out-of-band, then record the reference here.',
    );
  });

  it('reject a load', () => {
    expect(backoffice('reject', true, BO_LOAD)).toBe(
      "The 103.00 USD will not be collected, and the company's wallet is not credited.",
    );
  });

  it('reject a withdrawal or payout', () => {
    expect(backoffice('reject', false, BO_PAYOUT)).toBe(
      'The recipient will not be paid 97.00 USD, and the company keeps its funds.',
    );
  });

  // Every sentence back office can be shown, from the rows it is really sent.
  const cases: Array<[ReviewAction, boolean, typeof BO_LOAD | typeof BO_PAYOUT]> = [
    ['approve', true, BO_LOAD],
    ['reject', true, BO_LOAD],
    ['approve', false, BO_PAYOUT],
    ['reject', false, BO_PAYOUT],
  ];

  it('never renders the "—" of a figure the API strips', () => {
    for (const [action, isLoad, row] of cases) {
      expect(backoffice(action, isLoad, row)).not.toContain('—');
    }
  });

  it('never mentions a fee or a reserved amount', () => {
    for (const [action, isLoad, row] of cases) {
      const copy = backoffice(action, isLoad, row);
      expect(copy).not.toMatch(/fee/i);
      expect(copy).not.toMatch(/reserv/i);
      expect(copy).not.toMatch(/deduct/i);
    }
  });

  it('carries exactly one money figure — the one it is sent', () => {
    for (const [action, isLoad, row] of cases) {
      const figures = backoffice(action, isLoad, row).match(/\d[\d,]*\.\d{2} USD/g);
      expect(figures).toEqual([isLoad ? '103.00 USD' : '97.00 USD']);
    }
  });

  it('reads the same whether or not a network fee was charged', () => {
    for (const [action, isLoad, row] of cases) {
      expect(backoffice(action, isLoad, row, true)).toBe(backoffice(action, isLoad, row, false));
    }
  });
});

describe('reviewDoneMessage', () => {
  it('reads as a past tense for every flow and action', () => {
    expect(reviewDoneMessage('withdrawal', 'approve')).toBe('Withdrawal approved');
    expect(reviewDoneMessage('withdrawal', 'reject')).toBe('Withdrawal rejected');
    expect(reviewDoneMessage('payout', 'approve')).toBe('Payout approved');
    expect(reviewDoneMessage('payout', 'reject')).toBe('Payout rejected');
    expect(reviewDoneMessage('load', 'approve')).toBe('Load approved');
    expect(reviewDoneMessage('load', 'reject')).toBe('Load rejected');
  });
});
