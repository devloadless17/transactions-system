import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  eachBucketStartUtc,
  GRANULARITY_MAX_SPAN_MS,
  nextBucketStartUtc,
  pickGranularity,
  sqlTruncUnit,
  startOfBucketUtc,
  type BucketGranularity,
} from './analytics-buckets';

const DAY_MS = 24 * 3600 * 1000;
// Every assertion is built from Date.UTC so the host timezone is irrelevant —
// these helpers are UTC-only by design and a TZ-dependent test would hide that.
const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h));

describe('pickGranularity', () => {
  it('widens the bucket exactly at the documented thresholds', () => {
    const from = utc(2026, 1, 1);
    const at = (days: number) => pickGranularity(from, new Date(from.getTime() + days * DAY_MS));
    expect(at(92)).toBe('day');
    expect(at(93)).toBe('week');
    expect(at(731)).toBe('week');
    expect(at(732)).toBe('month');
  });

  it('keeps the common windows on day buckets', () => {
    const to = utc(2026, 9, 2);
    for (const days of [0, 1, 7, 30, 31, 90]) {
      expect(pickGranularity(new Date(to.getTime() - days * DAY_MS), to)).toBe('day');
    }
  });

  it('bounds the series length even for a decade of history', () => {
    const from = utc(2016, 1, 1);
    const to = utc(2026, 9, 2);
    const g = pickGranularity(from, to);
    expect(g).toBe('month');
    expect(eachBucketStartUtc(from, to, g).length).toBeLessThanOrEqual(130);
  });

  it('exposes thresholds that agree with the picker', () => {
    expect(GRANULARITY_MAX_SPAN_MS.day).toBe(92 * DAY_MS);
    expect(GRANULARITY_MAX_SPAN_MS.week).toBe(731 * DAY_MS);
  });
});

describe('startOfBucketUtc', () => {
  it('floors to UTC midnight for day buckets', () => {
    expect(startOfBucketUtc(utc(2026, 9, 2, 23), 'day').toISOString()).toBe(
      '2026-09-02T00:00:00.000Z',
    );
  });

  // Postgres date_trunc('week') is ISO — Monday. A Sunday-based week would
  // offset every bucket against the SQL grouping.
  it('backs up to Monday for week buckets, from every day of the week', () => {
    // 2026-08-31 is a Monday; walk that whole week.
    for (let i = 0; i < 7; i++) {
      const d = new Date(utc(2026, 8, 31).getTime() + i * DAY_MS);
      expect(bucketKey(startOfBucketUtc(d, 'week'))).toBe('2026-08-31');
    }
    // The next day starts a new week.
    expect(bucketKey(startOfBucketUtc(utc(2026, 9, 7), 'week'))).toBe('2026-09-07');
  });

  it('floors to the 1st for month buckets', () => {
    expect(bucketKey(startOfBucketUtc(utc(2026, 9, 30), 'month'))).toBe('2026-09-01');
    expect(bucketKey(startOfBucketUtc(utc(2026, 1, 1), 'month'))).toBe('2026-01-01');
  });
});

describe('nextBucketStartUtc', () => {
  it('advances one bucket without clamping across short months', () => {
    expect(bucketKey(nextBucketStartUtc(utc(2026, 1, 31), 'day'))).toBe('2026-02-01');
    expect(bucketKey(nextBucketStartUtc(utc(2026, 8, 31), 'week'))).toBe('2026-09-07');
    // A month bucket always starts on the 1st, so Jan → Feb can never clamp.
    expect(bucketKey(nextBucketStartUtc(utc(2026, 1, 1), 'month'))).toBe('2026-02-01');
    expect(bucketKey(nextBucketStartUtc(utc(2026, 12, 1), 'month'))).toBe('2027-01-01');
  });
});

describe('eachBucketStartUtc', () => {
  const granularities: BucketGranularity[] = ['day', 'week', 'month'];

  it('is contiguous, ordered and free of duplicates at every granularity', () => {
    for (const g of granularities) {
      const starts = eachBucketStartUtc(utc(2024, 3, 7), utc(2026, 9, 2), g);
      const keys = starts.map(bucketKey);
      expect(new Set(keys).size).toBe(keys.length);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i].getTime()).toBe(nextBucketStartUtc(starts[i - 1], g).getTime());
      }
    }
  });

  it('includes both end buckets even when partial', () => {
    // Month-to-date: the last bucket is a partial September.
    const starts = eachBucketStartUtc(utc(2026, 9, 1), utc(2026, 9, 2), 'month').map(bucketKey);
    expect(starts).toEqual(['2026-09-01']);
    // A window inside one day still yields that day.
    expect(
      eachBucketStartUtc(utc(2026, 9, 2, 3), utc(2026, 9, 2, 21), 'day').map(bucketKey),
    ).toEqual(['2026-09-02']);
  });

  it('covers a month-to-date window day by day', () => {
    const keys = eachBucketStartUtc(utc(2026, 9, 1), utc(2026, 9, 2), 'day').map(bucketKey);
    expect(keys).toEqual(['2026-09-01', '2026-09-02']);
  });
});

describe('sqlTruncUnit', () => {
  it('maps the three granularities', () => {
    expect(sqlTruncUnit('day')).toBe('day');
    expect(sqlTruncUnit('week')).toBe('week');
    expect(sqlTruncUnit('month')).toBe('month');
  });

  // The unit reaches Postgres as a bind parameter, so this is defence in depth —
  // but it must stay a throw, never a silent fallback to 'day'.
  it('throws on anything else instead of defaulting', () => {
    expect(() => sqlTruncUnit("day'; DROP TABLE transactions; --" as BucketGranularity)).toThrow(
      /unsupported bucket granularity/,
    );
    expect(() => sqlTruncUnit(undefined as unknown as BucketGranularity)).toThrow();
  });
});
