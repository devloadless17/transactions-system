'use client';
import {
  DateRangePicker,
  formatPickedLabel,
  type PickedRange,
  type RangePreset,
} from '@/components/ui/date-range-picker';
import { QUICK_RANGE_LABELS, QUICK_RANGE_ORDER } from '@/lib/date-presets';
import {
  DEFAULT_RANGE,
  quickIdForRange,
  rangeForQuickId,
  rangeTriggerLabel,
  type DateRange,
} from './range';

// The range model itself lives in ./range (a non-'use client' module) so server
// components can import it too. Re-exported here so existing call sites keep
// their single import.
export {
  ALL_TIME_KEY,
  ALL_TIME_PARAM,
  ALL_TIME_VALUE,
  analyticsRangeParams,
  DEFAULT_RANGE,
  isRangeReady,
  listRangeParams,
  quickIdForRange,
  rangeForQuickId,
  rangeKey,
  rangeLabel,
  rangePhrase,
  rangeTriggerLabel,
  resolveRange,
  type DateRange,
} from './range';

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

  // Built from the same order + labels the table filter bars use, so the two
  // families can never drift apart again.
  const active = quickIdForRange(value);
  const presets: RangePreset[] = QUICK_RANGE_ORDER.map((id) => ({
    label: QUICK_RANGE_LABELS[id],
    active: active === id,
    onSelect: () => onChange(rangeForQuickId(id)),
  }));

  const label = rangeTriggerLabel(value) ?? formatPickedLabel(picked);

  function handleChange(v: PickedRange) {
    if (v.from && v.to) {
      onChange({ mode: 'custom', from: v.from, to: v.to, fromTime: v.fromTime, toTime: v.toTime });
    } else {
      // Cleared → all time. The picker's Clear emits an empty range, which is
      // what "no date filter" already means on every table filter bar; making
      // it mean the same here keeps one mental model across the app.
      onChange({ mode: 'all' });
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
