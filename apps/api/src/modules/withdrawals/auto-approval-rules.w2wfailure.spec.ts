import { describe, expect, it } from 'vitest';
import { classifyW2WFailure } from './auto-approval-rules';

// Pins the mapping from a real Whish upstream code/message to the operator-facing
// failure category. All the sample codes are ones observed in production.
describe('classifyW2WFailure', () => {
  it('classifies a malformed recipient number as INVALID_RECIPIENT', () => {
    expect(
      classifyW2WFailure('auth.wrong_phone_format', 'Wrong phone number format: 7117886'),
    ).toBe('INVALID_RECIPIENT');
    expect(classifyW2WFailure(null, 'invalid recipient number')).toBe('INVALID_RECIPIENT');
  });

  it('classifies receiver-side rejections as RECEIVER', () => {
    expect(
      classifyW2WFailure(
        'account.topup.check.condition.fail',
        'This transaction could not be completed at this time. Please reach out to the receiver.',
      ),
    ).toBe('RECEIVER');
    expect(classifyW2WFailure('transfer.failed.title', 'Please reach out to the receiver.')).toBe(
      'RECEIVER',
    );
  });

  it('classifies a transient outage as TEMPORARY', () => {
    expect(classifyW2WFailure('off', 'Please try again later.')).toBe('TEMPORARY');
    expect(classifyW2WFailure(null, 'Service temporarily unavailable')).toBe('TEMPORARY');
  });

  it('falls back to GENERIC for anything unrecognised', () => {
    expect(classifyW2WFailure('some.new.code', 'brand new message')).toBe('GENERIC');
    expect(classifyW2WFailure(null, null)).toBe('GENERIC');
  });
});
