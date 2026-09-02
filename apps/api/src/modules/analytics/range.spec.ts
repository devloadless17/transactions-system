import { describe, expect, it } from 'vitest';
import { resolveWindow } from './range';

const DAY_MS = 24 * 3600 * 1000;
const iso = (s: string) => new Date(s).toISOString();

describe('resolveWindow', () => {
  describe('the default 30-day window (unchanged behaviour)', () => {
    it('spans 30 days back from now when nothing is supplied', () => {
      const w = resolveWindow({}, null);
      const span = w.to.getTime() - w.from.getTime();
      // `from` is floored to its bucket start, so the span is 30 days plus at
      // most the part of today already elapsed.
      expect(span).toBeGreaterThanOrEqual(30 * DAY_MS);
      expect(span).toBeLessThan(31 * DAY_MS);
      expect(w.granularity).toBe('day');
      expect(w.isAllTime).toBe(false);
    });

    it('honours explicit bounds verbatim', () => {
      const w = resolveWindow(
        { from: iso('2026-08-01T00:00:00Z'), to: iso('2026-09-02T12:34:00Z') },
        null,
      );
      expect(w.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(w.to.toISOString()).toBe('2026-09-02T12:34:00.000Z');
      expect(w.granularity).toBe('day');
    });

    it('resolves each bound independently (only `to` given)', () => {
      const w = resolveWindow({ to: iso('2026-09-02T00:00:00Z') }, null);
      expect(w.to.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      expect(w.from.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    });
  });

  // The old inline resolver used a millisecond-precision `new Date()`, so any
  // request omitting `to` produced a unique cache key and never hit the 60s
  // cache. Two calls in the same minute must now agree exactly.
  describe('cache-key stability', () => {
    it('anchors a derived `to` to the minute so a default window is cacheable', () => {
      const a = resolveWindow({}, null);
      const b = resolveWindow({}, null);
      expect(a.to.getTime() % 60_000).toBe(0);
      expect(a.to.toISOString()).toBe(b.to.toISOString());
    });

    // Rounding DOWN would drop anything written in the current partial minute —
    // a dashboard would stop showing what just happened, which is exactly what
    // the integration suite caught.
    it('rounds a derived `to` UP, never below now', () => {
      const before = Date.now();
      const w = resolveWindow({}, null);
      expect(w.to.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('leaves an explicit `to` untouched rather than widening it', () => {
      const w = resolveWindow({ to: iso('2026-09-02T12:34:56.789Z') }, null);
      expect(w.to.toISOString()).toBe('2026-09-02T12:34:56.789Z');
    });
  });

  describe("preset: 'all'", () => {
    it('starts at the origin and widens the bucket for a long history', () => {
      const origin = new Date('2019-04-17T09:13:22.000Z');
      const w = resolveWindow({ preset: 'all' }, origin);
      expect(w.isAllTime).toBe(true);
      expect(w.granularity).toBe('month');
      // Floored to the bucket start, so the first bucket is whole.
      expect(w.from.toISOString()).toBe('2019-04-01T00:00:00.000Z');
    });

    it('keeps day buckets when the whole history is short', () => {
      const origin = new Date(Date.now() - 10 * DAY_MS);
      const w = resolveWindow({ preset: 'all' }, origin);
      expect(w.granularity).toBe('day');
      expect(w.isAllTime).toBe(true);
    });

    it('picks week buckets for a mid-length history', () => {
      const origin = new Date(Date.now() - 200 * DAY_MS);
      expect(resolveWindow({ preset: 'all' }, origin).granularity).toBe('week');
    });

    // An empty platform has no origin: fall back to the default window so the
    // response is a valid empty series rather than a crash.
    it('falls back to the default window when there is no origin', () => {
      const w = resolveWindow({ preset: 'all' }, null);
      expect(w.isAllTime).toBe(false);
      expect(w.granularity).toBe('day');
      expect(w.to.getTime() - w.from.getTime()).toBeGreaterThanOrEqual(30 * DAY_MS);
    });
  });
});
