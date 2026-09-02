import { QUICK_RANGE_LABELS, type QuickRangeId } from '@/lib/date-presets';

/**
 * The dashboard/analytics range model and the query params it produces.
 *
 * Deliberately NOT a `'use client'` module (the `DateRangeControls` component
 * that consumes it is). Keeping the pure half importable from a server
 * component is what lets `app/(admin)/admin/page.tsx` derive its SSR prefetch
 * key from `DEFAULT_RANGE` instead of hand-copying a literal — the copy had
 * already drifted out of sync, silently disabling hydration. Same reasoning as
 * `features/company/process-configs.ts`.
 *
 * A range is the current calendar day, the current calendar month to date, a
 * rolling preset (last N days), all of history, or an explicit window the user
 * picked. Times are optional — when omitted a custom window spans the full
 * "from" day through the end of the "to" day.
 */
export type DateRange =
  | { mode: 'today' }
  | { mode: 'month' }
  | { mode: 'preset'; days: number }
  | { mode: 'all' }
  | { mode: 'custom'; from: string; to: string; fromTime?: string; toTime?: string }; // dates YYYY-MM-DD, times HH:mm

export const DEFAULT_RANGE: DateRange = { mode: 'today' };

/**
 * Query param that opts out of the API's default 30-day analytics window.
 *
 * Exported from one place so the two sides can't drift: the API accepts it as
 * `preset=all` on the analytics schemas only (see `analyticsPresetShape`).
 */
export const ALL_TIME_PARAM = 'preset';
export const ALL_TIME_VALUE = 'all';

/**
 * Absolute ISO bounds for the API, or NO bounds for all-time.
 *
 * Presets anchor `to` to the next minute so the backend's per-window cache key
 * stays stable across the dashboard's auto-refresh. A custom range uses
 * inclusive local bounds: the start of the "from" instant (default 00:00)
 * through the end of the "to" minute (default 23:59, i.e. end of day).
 *
 * The return type is partial on purpose. `URLSearchParams` takes only defined
 * strings, so widening it makes the compiler point at every consumer that
 * assumed two bounds — which is how the all-time mode gets wired everywhere
 * instead of silently degrading to a 30-day window somewhere.
 */
export function resolveRange(r: DateRange): { from?: string; to?: string } {
  if (r.mode === 'all') return {};
  if (r.mode === 'custom') {
    return {
      from: new Date(`${r.from}T${r.fromTime || '00:00'}:00`).toISOString(),
      to: new Date(`${r.to}T${r.toTime || '23:59'}:59.999`).toISOString(),
    };
  }

  const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
  if (r.mode === 'preset') {
    return {
      from: new Date(anchor - r.days * 24 * 3600 * 1000).toISOString(),
      to: new Date(anchor).toISOString(),
    };
  }

  // 'today' → local midnight; 'month' → local 1st of the month. Both run to now.
  const now = new Date(anchor);
  const start =
    r.mode === 'month'
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: start.toISOString(), to: new Date(anchor).toISOString() };
}

/**
 * Params for an ANALYTICS endpoint (overview, platform, flows, source/company
 * drilldowns).
 *
 * These endpoints default to the LAST 30 DAYS when no bounds are sent, so
 * "all time" has to be asked for explicitly — omitting from/to would quietly
 * return a month of data labelled as all of history.
 */
export function analyticsRangeParams(
  r: DateRange,
  extra?: Record<string, string>,
): URLSearchParams {
  const p = new URLSearchParams(extra);
  const { from, to } = resolveRange(r);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (r.mode === 'all') p.set(ALL_TIME_PARAM, ALL_TIME_VALUE);
  return p;
}

/**
 * Params for a LIST endpoint (activity, transactions, ledger, …).
 *
 * The mirror image: those apply no default window, so omitting from/to already
 * means "everything", and they have no `preset` field — sending one would be
 * stripped by zod and mean nothing at all.
 */
export function listRangeParams(r: DateRange, extra?: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams(extra);
  const { from, to } = resolveRange(r);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return p;
}

/**
 * Stable token for react-query keys so changing the range refetches.
 *
 * Deliberately carries no timestamp: SSR and the client each resolve the
 * absolute window at their own request time, and only a stable token makes
 * their keys agree so hydration takes.
 *
 * The `range:` prefix keeps these from colliding with ordinary key segments —
 * a bare 'all' would be indistinguishable from the ['sources', 'all'] key, and
 * the realtime layer matches on this token to decide what NOT to invalidate.
 */
export const ALL_TIME_KEY = 'range:all';

export function rangeKey(r: DateRange): string {
  switch (r.mode) {
    case 'today':
      return 'range:today';
    case 'month':
      return 'range:month';
    case 'all':
      return ALL_TIME_KEY;
    case 'preset':
      return `range:p${r.days}`;
    default:
      return `range:c${r.from}T${r.fromTime ?? ''}_${r.to}T${r.toTime ?? ''}`;
  }
}

/** Noun phrase for "…over <label>" copy. Pairs with a separator, e.g. "Fees earned · all time". */
export function rangeLabel(r: DateRange): string {
  switch (r.mode) {
    case 'today':
      return 'today';
    case 'month':
      return 'this month';
    case 'all':
      return 'all time';
    case 'preset':
      return `the last ${r.days} days`;
    default: {
      const f = r.fromTime ? `${r.from} ${r.fromTime}` : r.from;
      const t = r.toTime ? `${r.to} ${r.toTime}` : r.to;
      return `${f} → ${t}`;
    }
  }
}

/**
 * Same thing, but owning the preposition — "over all time" and "over today"
 * both read badly, so sentences interpolate this instead of hardcoding "over".
 */
export function rangePhrase(r: DateRange): string {
  switch (r.mode) {
    case 'today':
      return 'today';
    case 'month':
      return 'this month';
    case 'all':
      return 'across all time';
    default:
      return `over ${rangeLabel(r)}`;
  }
}

/**
 * True only once a custom range has both ends — queries should wait for it.
 *
 * Do NOT "simplify" this to check `resolveRange` for two bounds: an all-time
 * range resolves to none by design, and every all-time query would be pinned
 * to `enabled: false` forever.
 */
export function isRangeReady(r: DateRange): boolean {
  return r.mode !== 'custom' || Boolean(r.from && r.to);
}

/** Trigger label for the picker button. */
export function rangeTriggerLabel(r: DateRange): string | null {
  switch (r.mode) {
    case 'today':
      return QUICK_RANGE_LABELS.today;
    case 'month':
      return QUICK_RANGE_LABELS.month;
    case 'all':
      return QUICK_RANGE_LABELS.all;
    case 'preset':
      return `Last ${r.days} days`;
    default:
      return null; // custom → the picker formats the picked dates
  }
}

// ---- quick-range id <-> DateRange, so both families share one preset list ----

export function rangeForQuickId(id: QuickRangeId): DateRange {
  switch (id) {
    case 'today':
      return { mode: 'today' };
    case 'month':
      return { mode: 'month' };
    case 'all':
      return { mode: 'all' };
    case 'd7':
      return { mode: 'preset', days: 7 };
    case 'd30':
      return { mode: 'preset', days: 30 };
    case 'd90':
      return { mode: 'preset', days: 90 };
  }
}

export function quickIdForRange(r: DateRange): QuickRangeId | null {
  switch (r.mode) {
    case 'today':
      return 'today';
    case 'month':
      return 'month';
    case 'all':
      return 'all';
    case 'preset':
      return r.days === 7 ? 'd7' : r.days === 30 ? 'd30' : r.days === 90 ? 'd90' : null;
    default:
      return null;
  }
}
