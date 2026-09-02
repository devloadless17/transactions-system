import type { BucketGranularity } from '@app/shared';
import type { RangePreset } from '@/components/ui/date-range-picker';

/**
 * The quick ranges every date picker in the app offers, and the date maths
 * behind them.
 *
 * Deliberately NOT a `'use client'` module: it is pure, so a server component
 * can import it too (the admin dashboard derives its SSR prefetch key from the
 * same source rather than hand-copying a literal).
 *
 * Before this existed, four table filter bars each declared their own preset
 * array, their own `dayKey`, and their own `isoBound`, and the analytics
 * dashboards declared a fifth, different set. They had already drifted — the
 * dashboards offered "Last 90 days" and the tables did not.
 */
export type QuickRangeId = 'today' | 'month' | 'd7' | 'd30' | 'd90' | 'all';

/** THE canonical order. Every picker renders exactly this list, top to bottom. */
export const QUICK_RANGE_ORDER: readonly QuickRangeId[] = [
  'today',
  'month',
  'd7',
  'd30',
  'd90',
  'all',
] as const;

export const QUICK_RANGE_LABELS: Readonly<Record<QuickRangeId, string>> = {
  today: 'Today',
  month: 'This month',
  d7: 'Last 7 days',
  d30: 'Last 30 days',
  d90: 'Last 90 days',
  all: 'All time',
};

/**
 * Local YYYY-MM-DD, `offsetDays` before today (0 = today).
 *
 * Builds the parts by hand rather than going through `toISOString()`: the old
 * UTC-offset variant this replaces read `getTimezoneOffset()` AFTER shifting the
 * date, so on a DST-transition day it applied the wrong offset and could land on
 * the neighbouring day.
 */
export function dayKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return toKey(d);
}

/** Local YYYY-MM-DD for the 1st of the CURRENT calendar month. */
export function monthStartKey(): string {
  const d = new Date();
  return toKey(new Date(d.getFullYear(), d.getMonth(), 1));
}

function toKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Day-key bounds for a quick range. `all` yields NO bounds: on the list
 * endpoints an absent from/to genuinely means "everything", which RLS then
 * scopes to the caller — a company sees its own history, an admin the platform's.
 */
export function quickRangeBounds(id: QuickRangeId): { from?: string; to?: string } {
  switch (id) {
    case 'today':
      return { from: dayKey(0), to: dayKey(0) };
    case 'month':
      // Month-TO-DATE: on 2 September this is 1–2 September, not 30 rolling days.
      return { from: monthStartKey(), to: dayKey(0) };
    case 'd7':
      return { from: dayKey(6), to: dayKey(0) };
    case 'd30':
      return { from: dayKey(29), to: dayKey(0) };
    case 'd90':
      return { from: dayKey(89), to: dayKey(0) };
    case 'all':
      return {};
  }
}

/**
 * Build an inclusive ISO bound from a date (YYYY-MM-DD) + optional time (HH:mm).
 * Returns undefined for a malformed value (e.g. a tampered/stale URL like ?from=x)
 * so `.toISOString()` can't throw RangeError during render and crash the page into
 * an inescapable error boundary.
 */
export function isoBound(
  date: string,
  time: string | undefined,
  endOfDay: boolean,
): string | undefined {
  const t = time || (endOfDay ? '23:59' : '00:00');
  const d = new Date(`${date}T${t}:${endOfDay ? '59.999' : '00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Which quick range (if any) a picked value corresponds to — the single place
 * that decides preset highlighting.
 *
 * Two things the four hand-rolled copies got wrong:
 *   - some filter bars store cleared bounds as `''` and others as `undefined`,
 *     and `'' === undefined` is false, so "no dates" could never highlight;
 *   - a window with an explicit time is not a whole-day quick range, but a
 *     copy that forgot the time check would highlight one anyway.
 */
export function matchQuickRange(v: {
  from?: string;
  to?: string;
  fromTime?: string;
  toTime?: string;
}): QuickRangeId | null {
  if (v.fromTime || v.toTime) return null;
  const from = v.from || undefined;
  const to = v.to || undefined;
  if (!from && !to) return 'all';
  for (const id of QUICK_RANGE_ORDER) {
    const b = quickRangeBounds(id);
    if (b.from === from && b.to === to) return id;
  }
  return null;
}

/**
 * The six presets for a table filter bar. `onSelect` receives the new bounds
 * (both undefined for "All time"); the caller applies them to its own filter
 * shape and is responsible for clearing any time-of-day alongside.
 */
export function quickRangePresets(
  current: { from?: string; to?: string; fromTime?: string; toTime?: string },
  onSelect: (bounds: { from?: string; to?: string }) => void,
): RangePreset[] {
  const active = matchQuickRange(current);
  return QUICK_RANGE_ORDER.map((id) => ({
    label: QUICK_RANGE_LABELS[id],
    active: active === id,
    onSelect: () => onSelect(quickRangeBounds(id)),
  }));
}

// ---- chart bucket labelling ----------------------------------------------
//
// The analytics series widens its bucket as the window grows (day → week →
// month), so a chart MUST label ticks by the granularity the server reports.
// Rendering a month bucket with the old MM-DD format showed "09-01", which
// reads as a single day — the most misleading failure this feature could have.

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

// Bucket dates are plain YYYY-MM-DD keys of a UTC bucket start. Split them by
// hand rather than via `new Date(...)`, which would re-interpret them in the
// viewer's local zone and can shift the label back a day west of UTC.
function parseKey(date: string): { y: number; m: number; d: number } | null {
  const [y, m, d] = date.split('-').map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? { y, m, d } : null;
}

/** Short axis tick for one bucket. */
export function formatBucketTick(date: string, granularity: BucketGranularity): string {
  const p = parseKey(date);
  if (!p) return date;
  if (granularity === 'month') return `${MONTHS[p.m - 1]} ${String(p.y).slice(2)}`;
  return `${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Fuller label for the tooltip header, where the bucket's span must be unambiguous. */
export function formatBucketTooltip(date: string, granularity: BucketGranularity): string {
  const p = parseKey(date);
  if (!p) return date;
  const day = `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
  if (granularity === 'month') return `${MONTHS[p.m - 1]} ${p.y}`;
  if (granularity === 'week') return `Week of ${day}`;
  return day;
}

/** "Daily" / "Weekly" / "Monthly", for chart captions that name the series. */
export function granularityWord(granularity: BucketGranularity): string {
  return granularity === 'month' ? 'Monthly' : granularity === 'week' ? 'Weekly' : 'Daily';
}
