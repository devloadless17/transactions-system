import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dayKey,
  formatBucketTick,
  formatBucketTooltip,
  granularityWord,
  isoBound,
  matchQuickRange,
  monthStartKey,
  QUICK_RANGE_LABELS,
  QUICK_RANGE_ORDER,
  quickRangeBounds,
  quickRangePresets,
} from './date-presets';

/**
 * These helpers decide which rows land in a money report, so the edges matter:
 * month boundaries, DST transitions, and the ''-vs-undefined mismatch between
 * the filter bars. `dayKey` / `monthStartKey` are LOCAL-time by design (they
 * feed a date the user picked in a calendar), which is why the suite is also
 * run under a second timezone in CI — see the `test` script.
 */

// Freeze the clock so "today" is deterministic. Local noon, so the assertions
// are not sitting on a midnight boundary in either direction.
function freeze(localIso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(localIso));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('monthStartKey', () => {
  it('returns the 1st of the current month', () => {
    freeze('2026-09-02T12:00:00');
    expect(monthStartKey()).toBe('2026-09-01');
  });

  it('is stable on the 1st itself', () => {
    freeze('2026-03-01T12:00:00');
    expect(monthStartKey()).toBe('2026-03-01');
  });

  it('handles the last day of a month', () => {
    freeze('2026-01-31T12:00:00');
    expect(monthStartKey()).toBe('2026-01-01');
  });

  it('handles a leap-day', () => {
    freeze('2028-02-29T12:00:00');
    expect(monthStartKey()).toBe('2028-02-01');
  });
});

describe('dayKey', () => {
  it('walks back whole days across a month boundary', () => {
    freeze('2026-09-02T12:00:00');
    expect(dayKey(0)).toBe('2026-09-02');
    expect(dayKey(1)).toBe('2026-09-01');
    expect(dayKey(2)).toBe('2026-08-31');
    expect(dayKey(6)).toBe('2026-08-27');
    expect(dayKey(29)).toBe('2026-08-04');
    expect(dayKey(89)).toBe('2026-06-05');
  });

  it('crosses a year boundary', () => {
    freeze('2026-01-01T12:00:00');
    expect(dayKey(1)).toBe('2025-12-31');
  });

  // The implementation this replaced read getTimezoneOffset() AFTER shifting the
  // date, so on a DST-transition day it applied the wrong offset and could
  // return the neighbouring day.
  it('is correct across a DST transition', () => {
    freeze('2026-03-30T12:00:00'); // day after Europe's spring-forward
    expect(dayKey(0)).toBe('2026-03-30');
    expect(dayKey(1)).toBe('2026-03-29');
    expect(dayKey(2)).toBe('2026-03-28');
  });
});

describe('quickRangeBounds', () => {
  beforeEach(() => freeze('2026-09-02T12:00:00'));

  // THE headline requirement: on 2 September, "This month" is 1–2 September.
  it('makes "This month" month-to-date, not a rolling 30 days', () => {
    expect(quickRangeBounds('month')).toEqual({ from: '2026-09-01', to: '2026-09-02' });
  });

  it('covers the rolling presets inclusively', () => {
    expect(quickRangeBounds('today')).toEqual({ from: '2026-09-02', to: '2026-09-02' });
    // 7 calendar days INCLUDING today → 6 days back.
    expect(quickRangeBounds('d7')).toEqual({ from: '2026-08-27', to: '2026-09-02' });
    expect(quickRangeBounds('d30')).toEqual({ from: '2026-08-04', to: '2026-09-02' });
    expect(quickRangeBounds('d90')).toEqual({ from: '2026-06-05', to: '2026-09-02' });
  });

  it('gives "All time" no bounds at all', () => {
    expect(quickRangeBounds('all')).toEqual({});
  });

  it('offers exactly six ranges in a fixed order', () => {
    expect(QUICK_RANGE_ORDER).toEqual(['today', 'month', 'd7', 'd30', 'd90', 'all']);
    expect(QUICK_RANGE_ORDER.map((id) => QUICK_RANGE_LABELS[id])).toEqual([
      'Today',
      'This month',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
      'All time',
    ]);
  });
});

describe('isoBound', () => {
  it('spans the whole day when no time is given', () => {
    expect(isoBound('2026-09-02', undefined, false)).toBe(
      new Date('2026-09-02T00:00:00').toISOString(),
    );
    expect(isoBound('2026-09-02', undefined, true)).toBe(
      new Date('2026-09-02T23:59:59.999').toISOString(),
    );
  });

  it('honours an explicit time', () => {
    expect(isoBound('2026-09-02', '09:30', false)).toBe(
      new Date('2026-09-02T09:30:00').toISOString(),
    );
  });

  // A tampered or stale URL (?from=x) must not throw during render.
  it('returns undefined for a malformed date instead of throwing', () => {
    expect(isoBound('not-a-date', undefined, false)).toBeUndefined();
    expect(isoBound('', undefined, true)).toBeUndefined();
  });
});

describe('matchQuickRange', () => {
  beforeEach(() => freeze('2026-09-02T12:00:00'));

  it('treats no bounds as "All time"', () => {
    expect(matchQuickRange({})).toBe('all');
  });

  // Some filter bars store cleared bounds as '' rather than undefined, and
  // '' === undefined is false — which is why "no dates" never highlighted.
  it('treats empty-string bounds as "All time" too', () => {
    expect(matchQuickRange({ from: '', to: '' })).toBe('all');
  });

  it('identifies each preset from its bounds', () => {
    for (const id of QUICK_RANGE_ORDER) {
      expect(matchQuickRange(quickRangeBounds(id))).toBe(id);
    }
  });

  it('matches nothing for an arbitrary custom window', () => {
    expect(matchQuickRange({ from: '2020-01-01', to: '2020-02-01' })).toBeNull();
  });

  // A window with a time-of-day is not a whole-day quick range.
  it('matches nothing once a time is set', () => {
    expect(matchQuickRange({ ...quickRangeBounds('today'), fromTime: '09:00' })).toBeNull();
    expect(matchQuickRange({ ...quickRangeBounds('d7'), toTime: '17:30' })).toBeNull();
  });
});

describe('quickRangePresets', () => {
  beforeEach(() => freeze('2026-09-02T12:00:00'));

  it('marks exactly one preset active', () => {
    const presets = quickRangePresets(quickRangeBounds('d30'), () => {});
    expect(presets.filter((p) => p.active).map((p) => p.label)).toEqual(['Last 30 days']);
  });

  it('marks "All time" active when nothing is picked', () => {
    const presets = quickRangePresets({}, () => {});
    expect(presets.filter((p) => p.active).map((p) => p.label)).toEqual(['All time']);
  });

  it('hands the chosen bounds to the caller', () => {
    const seen: Array<{ from?: string; to?: string }> = [];
    const presets = quickRangePresets({}, (b) => seen.push(b));
    presets.find((p) => p.label === 'This month')?.onSelect();
    presets.find((p) => p.label === 'All time')?.onSelect();
    expect(seen).toEqual([{ from: '2026-09-01', to: '2026-09-02' }, {}]);
  });
});

describe('bucket labelling', () => {
  // A month bucket rendered as MM-DD reads as a single day — the most
  // misleading thing this feature could do.
  it('labels ticks by granularity', () => {
    expect(formatBucketTick('2026-09-01', 'day')).toBe('09-01');
    expect(formatBucketTick('2026-09-01', 'week')).toBe('09-01');
    expect(formatBucketTick('2026-09-01', 'month')).toBe('Sep 26');
  });

  it('spells the span out in the tooltip', () => {
    expect(formatBucketTooltip('2026-09-02', 'day')).toBe('Sep 2, 2026');
    expect(formatBucketTooltip('2026-08-31', 'week')).toBe('Week of Aug 31, 2026');
    expect(formatBucketTooltip('2026-09-01', 'month')).toBe('Sep 2026');
  });

  it('names the series', () => {
    expect(granularityWord('day')).toBe('Daily');
    expect(granularityWord('week')).toBe('Weekly');
    expect(granularityWord('month')).toBe('Monthly');
  });

  it('passes a malformed key through instead of throwing', () => {
    expect(formatBucketTick('nonsense', 'day')).toBe('nonsense');
    expect(formatBucketTooltip('nonsense', 'month')).toBe('nonsense');
  });
});
