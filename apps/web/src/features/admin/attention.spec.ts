import { describe, expect, it } from 'vitest';
import { heldForText, plural } from './attention';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('heldForText — how long money has waited for a person', () => {
  it('minutes, then hours, then days', () => {
    expect(heldForText(ago(30_000), NOW)).toBe('for 1 minute');
    expect(heldForText(ago(7 * 60_000), NOW)).toBe('for 7 minutes');
    expect(heldForText(ago(60 * 60_000), NOW)).toBe('for 1 hour');
    expect(heldForText(ago(47 * 3_600_000), NOW)).toBe('for 47 hours');
    expect(heldForText(ago(48 * 3_600_000), NOW)).toBe('for 2 days');
    // The Oct 2 stuck withdrawal, read on Oct 14.
    expect(heldForText('2026-10-02T13:25:50.824Z', NOW)).toBe('for 11 days');
  });

  it('nothing to say without a valid date, and never negative', () => {
    expect(heldForText(null, NOW)).toBeNull();
    expect(heldForText('not a date', NOW)).toBeNull();
    expect(heldForText(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe('for 1 minute');
  });

  it('plural', () => {
    expect(plural(1, 'withdrawal')).toBe('1 withdrawal');
    expect(plural(3, 'payment')).toBe('3 payments');
  });
});
