import { describe, expect, it } from 'vitest';
import {
  createPayoutDetailsSchema,
  isValidLebaneseMobile,
  isValidWishRecipientPhone,
  lebaneseMobileNsn,
} from './payout-method';
import { PayoutMethod } from '../enums';

// The WISH recipientPhone must (a) be phone-SHAPED — accept every real format an
// integrator/operator might send (E.164, local, spaces/dashes/parens/+) and reject
// non-phones ("N/A", a name). AND (b): W2W is NOT Lebanese-only, so only a number that
// EXPLICITLY carries the 961 country code is held to the Lebanese-MSISDN rule (8 digits,
// or 7 when it starts with 3) — catching the prod bug 9617075183 up front — while any
// other country code / bare-local number passes on shape alone (never blocking a valid
// international recipient). The read/legacy union stays tolerant (not tested here).

const wish = (recipientPhone: string) =>
  createPayoutDetailsSchema.safeParse({
    method: PayoutMethod.WISH,
    recipientName: 'Jane Doe',
    recipientPhone,
  });

describe('WISH recipientPhone — create-path validation', () => {
  it('accepts real phone formats, Lebanese AND international', () => {
    for (const p of [
      '+96171505894', // Lebanese E.164 — 8-digit NSN
      '71505894', // bare local (no country code) — tolerant, not forced Lebanese
      '+961 71 505 894', // Lebanese, spaces
      '(03) 123-456', // → 3123456 (7-digit "3" family)
      '+9613702825', // Lebanese "3" family, 7-digit NSN
      '+15551234567', // US — W2W is not Lebanese-only, must NOT be blocked
      '+971501234567', // UAE international
    ]) {
      expect(wish(p).success, p).toBe(true);
    }
  });

  it('rejects non-phones and out-of-range digit counts', () => {
    for (const p of ['N/A', 'John Doe', '12345', '', '03 ext 5', '1234567890123456']) {
      expect(wish(p).success, p).toBe(false);
    }
  });

  it('rejects ONLY malformed 961-tagged Lebanese numbers', () => {
    for (const p of [
      '9617075183', // the prod failure: 961 + 7075183 = 7 digits, non-3 prefix
      '+961715058', // 961 + 6 digits — too short
      '0096171505', // 00961 + 5 digits — too short
    ]) {
      expect(wish(p).success, p).toBe(false);
    }
  });
});

describe('lebaneseMobileNsn / isValidLebaneseMobile / isValidWishRecipientPhone', () => {
  it('normalises to the national number across formats', () => {
    expect(lebaneseMobileNsn('+961 71 505 894')).toBe('71505894');
    expect(lebaneseMobileNsn('0096171505894')).toBe('71505894');
    expect(lebaneseMobileNsn('071505894')).toBe('71505894');
    expect(lebaneseMobileNsn('+961 3 702825')).toBe('3702825');
  });

  it('applies the 8-digit rule (7 when it starts with 3)', () => {
    expect(isValidLebaneseMobile('71505894')).toBe(true); // 8 digits
    expect(isValidLebaneseMobile('3702825')).toBe(true); // 7 digits, "3"
    expect(isValidLebaneseMobile('9617075183')).toBe(false); // 7 digits, non-3
    expect(isValidLebaneseMobile('37028251')).toBe(false); // 8 digits, "3" → too long
  });

  it('only enforces the Lebanese rule for 961-tagged numbers', () => {
    expect(isValidWishRecipientPhone('9617075183')).toBe(false); // malformed LB
    expect(isValidWishRecipientPhone('96171505894')).toBe(true); // valid LB
    expect(isValidWishRecipientPhone('+15551234567')).toBe(true); // US — not held to LB rule
    expect(isValidWishRecipientPhone('71505894')).toBe(true); // bare local — shape only
  });
});
