import { describe, expect, it } from 'vitest';
import { adminAnalyticsRangeSchema, flowsRangeSchema } from './admin-analytics';
import { analyticsRangeSchema } from './analytics';

const DAY_MS = 24 * 3600 * 1000;
const FROM = '2026-01-01T00:00:00.000Z';
const at = (days: number) => new Date(Date.parse(FROM) + days * DAY_MS).toISOString();

// Every analytics range schema must behave identically — a gap in one of them
// is a gap in the guard, since they all front throttle-exempt endpoints.
const schemas = {
  analyticsRangeSchema,
  adminAnalyticsRangeSchema,
  // flows additionally requires a currency.
  flowsRangeSchema,
} as const;

const withCurrency = (name: keyof typeof schemas, v: Record<string, unknown>) =>
  name === 'flowsRangeSchema' ? { ...v, currency: 'USD' } : v;

describe.each(Object.keys(schemas) as (keyof typeof schemas)[])('%s', (name) => {
  const schema = schemas[name];
  const parse = (v: Record<string, unknown>) => schema.safeParse(withCurrency(name, v));

  describe('the 366-day cap (regression guard — must not erode)', () => {
    it('accepts a 366-day span', () => {
      expect(parse({ from: FROM, to: at(366) }).success).toBe(true);
    });

    it('rejects a 367-day span', () => {
      const res = parse({ from: FROM, to: at(367) });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toMatch(/must not exceed 366 days/);
      }
    });

    it('rejects an inverted range', () => {
      const res = parse({ from: at(5), to: FROM });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.issues[0].message).toMatch(/on or after/);
    });
  });

  describe("preset: 'all'", () => {
    it('is accepted on its own', () => {
      const res = parse({ preset: 'all' });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.preset).toBe('all');
    });

    // Rejected, not ignored: silently dropping either side would return a
    // window that doesn't match what the caller asked for.
    it('is rejected alongside from', () => {
      const res = parse({ preset: 'all', from: FROM });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.issues[0].message).toMatch(/cannot be combined/);
    });

    it('is rejected alongside to', () => {
      expect(parse({ preset: 'all', to: at(1) }).success).toBe(false);
    });

    it('is rejected alongside a full range', () => {
      expect(parse({ preset: 'all', from: FROM, to: at(1) }).success).toBe(false);
    });

    it('rejects any other preset value', () => {
      expect(parse({ preset: 'everything' }).success).toBe(false);
      expect(parse({ preset: 'day' }).success).toBe(false);
    });
  });

  it('still accepts an empty query (the 30-day server default)', () => {
    expect(parse({}).success).toBe(true);
  });

  // A single bound has always skipped the cap; documented, pre-existing, and
  // deliberately unchanged here so the behaviour is pinned rather than assumed.
  it('accepts a lone bound (cap only applies when both are present)', () => {
    expect(parse({ from: FROM }).success).toBe(true);
    expect(parse({ to: at(1) }).success).toBe(true);
  });
});
