import { z } from 'zod';

/**
 * Bucket granularity for the analytics time series.
 *
 * The dashboards used to bucket per-day unconditionally, which is why the
 * analytics range schemas cap an explicit window at 366 days (see
 * `assertSaneDateRange`): an unbounded range would otherwise force both a huge
 * scan and an unbounded bucket array on throttle-exempt endpoints. "All time"
 * needs a window nobody can cap, so instead of a fixed day bucket the server
 * widens the bucket as the span grows — the row count stays bounded no matter
 * how much history accumulates.
 *
 * All maths here is deliberately UTC-only: Postgres `date_trunc` is applied to
 * `AT TIME ZONE 'UTC'` timestamps, so the walkers that fill bucket gaps must
 * agree. Working in UTC also makes DST structurally impossible to get wrong.
 */
export const bucketGranularitySchema = z.enum(['day', 'week', 'month']);
export type BucketGranularity = z.infer<typeof bucketGranularitySchema>;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Upper span bound (inclusive) for each granularity below the widest one.
 * Chosen so the returned series stays small at every scale:
 *   day   ≤ 92d  → ≤ 93 buckets   (a quarter at full detail)
 *   week  ≤ 731d → ≤ 105 buckets  (two years)
 *   month otherwise → ~12/year    (ten years ≈ 120 buckets)
 */
export const GRANULARITY_MAX_SPAN_MS: Readonly<Record<'day' | 'week', number>> = Object.freeze({
  day: 92 * DAY_MS,
  week: 731 * DAY_MS,
});

/** Widen the bucket as the window grows, so the series length stays bounded. */
export function pickGranularity(from: Date, to: Date): BucketGranularity {
  const span = to.getTime() - from.getTime();
  if (span <= GRANULARITY_MAX_SPAN_MS.day) return 'day';
  if (span <= GRANULARITY_MAX_SPAN_MS.week) return 'week';
  return 'month';
}

/**
 * Start of the bucket containing `d`, in UTC.
 *
 * Weeks start on MONDAY to match Postgres `date_trunc('week', …)`, which is
 * ISO-8601. Getting this wrong would offset every week bucket by a day or two
 * against the SQL grouping and leave the gap-filler emitting empty buckets
 * beside the real ones.
 */
export function startOfBucketUtc(d: Date, g: BucketGranularity): Date {
  const out = new Date(d.getTime());
  if (g === 'month') {
    return new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth(), 1));
  }
  if (g === 'week') {
    // getUTCDay(): 0=Sun..6=Sat. Shift so Monday=0, then walk back that many days.
    out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  }
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/** Start of the bucket after the one beginning at `d` (which must be a bucket start). */
export function nextBucketStartUtc(d: Date, g: BucketGranularity): Date {
  const out = new Date(d.getTime());
  if (g === 'day') out.setUTCDate(out.getUTCDate() + 1);
  else if (g === 'week') out.setUTCDate(out.getUTCDate() + 7);
  // Safe: a month bucket always starts on the 1st, so this never clamps.
  else out.setUTCMonth(out.getUTCMonth() + 1);
  return out;
}

/**
 * Every bucket start from the one containing `from` through the one containing
 * `to`, inclusive. Both end buckets are included even when partial — the last
 * one usually is (a month-to-date window ends mid-month).
 */
export function eachBucketStartUtc(from: Date, to: Date, g: BucketGranularity): Date[] {
  const end = startOfBucketUtc(to, g).getTime();
  const out: Date[] = [];
  for (let cursor = startOfBucketUtc(from, g); cursor.getTime() <= end; ) {
    out.push(cursor);
    cursor = nextBucketStartUtc(cursor, g);
  }
  return out;
}

/**
 * Wire format for a bucket's `date` field: YYYY-MM-DD of the bucket START.
 * Identical to the day-only `toDateKey` this replaces, so the response shape is
 * unchanged — the field just means "start of bucket" rather than "the day".
 */
export function bucketKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Whitelist the SQL `date_trunc` unit.
 *
 * The unit reaches Postgres as a real bind parameter (`date_trunc($n::text, …)`),
 * never string interpolation, so this is belt-and-braces on a value that is
 * already server-derived. It throws rather than defaulting: a granularity that
 * isn't one of these means a bug, and silently bucketing by day would return
 * a wrong-shaped series instead of failing.
 */
export function sqlTruncUnit(g: BucketGranularity): 'day' | 'week' | 'month' {
  const unit = TRUNC_UNITS[g];
  if (!unit) throw new Error(`unsupported bucket granularity: ${String(g)}`);
  return unit;
}

const TRUNC_UNITS: Readonly<Record<BucketGranularity, 'day' | 'week' | 'month'>> = Object.freeze({
  day: 'day',
  week: 'week',
  month: 'month',
});
