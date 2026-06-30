import { describe, expect, it } from 'vitest';
import { createPayoutDetailsSchema } from './payout-method';
import { PayoutMethod } from '../enums';

// The WISH recipientPhone was loosened from `min(4)` to a tolerant phone-shape check:
// it must accept every real format an integrator/operator might send (E.164, local,
// spaces/dashes/parens/+) yet reject non-phones ("N/A", a name) that used to slip
// through and only fail later at Whish. These pin that contract.

const wish = (recipientPhone: string) =>
  createPayoutDetailsSchema.safeParse({
    method: PayoutMethod.WISH,
    recipientName: 'Jane Doe',
    recipientPhone,
  });

describe('WISH recipientPhone — tolerant phone validation', () => {
  it('accepts every real phone format', () => {
    for (const p of [
      '+96171505894', // E.164 (what the new country picker emits)
      '71505894', // bare local Lebanese (what prod uses today)
      '+961 71 505 894', // spaces
      '(03) 123-456', // parens + dash
      '03-123-456', // dashes
      '+15551234567', // international (US)
    ]) {
      expect(wish(p).success, p).toBe(true);
    }
  });

  it('rejects non-phones and out-of-range digit counts', () => {
    for (const p of [
      'N/A', // not a phone (the classic garbage that used to pass)
      'John Doe', // a name
      '12345', // too few digits (<6)
      '', // empty
      '03 ext 5', // letters
      '1234567890123456', // too many digits (>15)
    ]) {
      expect(wish(p).success, p).toBe(false);
    }
  });
});
