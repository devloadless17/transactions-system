'use client';
import {
  DateRangePicker,
  formatPickedLabel,
  type PickedRange,
  type RangePreset,
} from '@/components/ui/date-range-picker';

// A range is either the current calendar day (midnight → now), a rolling
// preset (last N days), or an explicit between-two-dates window the user
// picked. Times are optional — when omitted the window spans the full "from"
// day through the end of the "to" day.
export type DateRange =
  | { mode: 'today' }
  | { mode: 'preset'; days: number }
  | { mode: 'custom'; from: string; to: string; fromTime?: string; toTime?: string }; // dates YYYY-MM-DD, times HH:mm

export const DEFAULT_RANGE: DateRange = { mode: 'today' };

const PRESETS = [7, 30, 90];

/**
 * Absolute ISO bounds for the API. Presets anchor `to` to the next minute so
 * the backend's per-window cache key stays stable across the dashboard's
 * auto-refresh. A custom range uses inclusive local bounds: the start of the
 * "from" instant (default 00:00) through the end of the "to" minute (default
 * 23:59, i.e. end of day).
 */
export function resolveRange(r: DateRange): { from: string; to: string } {
  if (r.mode === 'today') {
    // Local midnight today → now (upper bound anchored to the minute, like presets).
    const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
    const now = new Date(anchor);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from: start.toISOString(), to: new Date(anchor).toISOString() };
  }
  if (r.mode === 'preset') {
    const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
    return {
      from: new Date(anchor - r.days * 24 * 3600 * 1000).toISOString(),
      to: new Date(anchor).toISOString(),
    };
  }
  return {
    from: new Date(`${r.from}T${r.fromTime || '00:00'}:00`).toISOString(),
    to: new Date(`${r.to}T${r.toTime || '23:59'}:59.999`).toISOString(),
  };
}

// Stable token for react-query keys so changing the range refetches.
export function rangeKey(r: DateRange): string {
  if (r.mode === 'today') return 'today';
  return r.mode === 'preset'
    ? `p${r.days}`
    : `c${r.from}T${r.fromTime ?? ''}_${r.to}T${r.toTime ?? ''}`;
}

// Human label for "…over <label>" copy.
export function rangeLabel(r: DateRange): string {
  if (r.mode === 'today') return 'today';
  if (r.mode === 'preset') return `the last ${r.days} days`;
  const f = r.fromTime ? `${r.from} ${r.fromTime}` : r.from;
  const t = r.toTime ? `${r.to} ${r.toTime}` : r.to;
  return `${f} → ${t}`;
}

// True only once a custom range has both ends — queries should wait for it.
export function isRangeReady(r: DateRange): boolean {
  return r.mode !== 'custom' || Boolean(r.from && r.to);
}

export function DateRangeControls({
  value,
  onChange,
  className,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
}) {
  const picked: PickedRange =
    value.mode === 'custom'
      ? { from: value.from, to: value.to, fromTime: value.fromTime, toTime: value.toTime }
      : {};

  const presets: RangePreset[] = [
    {
      label: 'Today',
      active: value.mode === 'today',
      onSelect: () => onChange({ mode: 'today' }),
    },
    ...PRESETS.map((d) => ({
      label: `Last ${d} days`,
      active: value.mode === 'preset' && value.days === d,
      onSelect: () => onChange({ mode: 'preset', days: d }),
    })),
  ];

  const label =
    value.mode === 'today'
      ? 'Today'
      : value.mode === 'preset'
        ? `Last ${value.days} days`
        : formatPickedLabel(picked);

  function handleChange(v: PickedRange) {
    if (v.from && v.to) {
      onChange({ mode: 'custom', from: v.from, to: v.to, fromTime: v.fromTime, toTime: v.toTime });
    } else {
      onChange(DEFAULT_RANGE); // cleared → fall back to the default preset
    }
  }

  return (
    <DateRangePicker
      className={className}
      value={picked}
      onChange={handleChange}
      presets={presets}
      label={label}
      align="end"
    />
  );
}
