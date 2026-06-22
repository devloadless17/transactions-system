'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { type DateRange as RdpRange } from 'react-day-picker';
import { format } from 'date-fns';
import { CalendarIcon, Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';

// Lazily load the react-day-picker Calendar so it (plus its date-math helpers,
// ~22-27KB gz) stays off the initial JS of every date-filtered route. It only
// ever renders inside the open Popover (client-side, open-gated), so it never
// renders during SSR — no `ssr: false` needed (and ssr:false trips a Next 15
// /404 prerender bug; see volume-chart.lazy.tsx). The fallback matches the
// calendar's footprint so opening the popover doesn't shift layout.
const Calendar = dynamic(() => import('@/components/ui/calendar').then((m) => m.Calendar), {
  loading: () => <div className="h-[18rem] w-[16rem] animate-pulse rounded bg-muted" />,
});

// Dates are YYYY-MM-DD, times optional HH:mm. A whole-day window when no time.
export interface PickedRange {
  from?: string;
  to?: string;
  fromTime?: string;
  toTime?: string;
}

export interface RangePreset {
  label: string;
  active: boolean;
  onSelect: () => void;
}

// --- date <-> YYYY-MM-DD helpers (local, no timezone drift) ---
function toKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function fromKey(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Pretty label for a committed range, e.g. "Jun 1 – Jun 2, 2026" (+ times).
export function formatPickedLabel(v: PickedRange): string {
  if (!v.from && !v.to) return '';
  const f = v.from ? fromKey(v.from) : undefined;
  const t = v.to ? fromKey(v.to) : undefined;
  const sameYear = f && t && f.getFullYear() === t.getFullYear();
  const fStr = f ? format(f, sameYear ? 'MMM d' : 'MMM d, yyyy') : '…';
  const tStr = t ? format(t, 'MMM d, yyyy') : '…';
  return `${fStr}${v.fromTime ? ` ${v.fromTime}` : ''} – ${tStr}${v.toTime ? ` ${v.toTime}` : ''}`;
}

export function DateRangePicker({
  value,
  onChange,
  presets,
  label,
  placeholder = 'Pick a date range',
  align = 'start',
  numberOfMonths = 2,
  className,
}: {
  value: PickedRange;
  onChange: (v: PickedRange) => void;
  presets?: RangePreset[];
  /** Trigger label override; falls back to a formatted range. */
  label?: string;
  placeholder?: string;
  align?: 'start' | 'end';
  numberOfMonths?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PickedRange>(value);
  const [showTime, setShowTime] = useState(Boolean(value.fromTime || value.toTime));

  function handleOpenChange(next: boolean) {
    if (next) {
      setDraft(value);
      setShowTime(Boolean(value.fromTime || value.toTime));
    }
    setOpen(next);
  }

  const selected: RdpRange | undefined = draft.from
    ? { from: fromKey(draft.from), to: draft.to ? fromKey(draft.to) : undefined }
    : undefined;

  const complete = Boolean(draft.from && draft.to);
  const triggerLabel = label || formatPickedLabel(value);

  function apply() {
    onChange(draft);
    setOpen(false);
  }
  function clear() {
    onChange({});
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 justify-start gap-2 font-normal',
            !triggerLabel && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 opacity-70" />
          <span className="truncate">{triggerLabel || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="flex flex-col sm:flex-row">
        {presets && presets.length > 0 && (
          <div className="flex min-w-[8.5rem] flex-col gap-0.5 border-b p-2 sm:border-b-0 sm:border-r">
            <span className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
              Quick ranges
            </span>
            {presets.map((p) => (
              <Button
                key={p.label}
                variant={p.active ? 'secondary' : 'ghost'}
                size="sm"
                className="justify-start font-normal"
                onClick={() => {
                  p.onSelect();
                  setOpen(false);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-col">
          <Calendar
            mode="range"
            numberOfMonths={numberOfMonths}
            selected={selected}
            defaultMonth={selected?.from ?? new Date()}
            disabled={{ after: new Date() }}
            onSelect={(r) =>
              setDraft((d) => ({
                ...d,
                from: r?.from ? toKey(r.from) : undefined,
                to: r?.to ? toKey(r.to) : undefined,
              }))
            }
          />

          <div className="space-y-3 border-t p-3">
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant={showTime ? 'secondary' : 'ghost'}
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  if (showTime) setDraft((d) => ({ ...d, fromTime: undefined, toTime: undefined }));
                  setShowTime((s) => !s);
                }}
              >
                <Clock className="h-3.5 w-3.5" />
                {showTime ? 'Time on' : 'Add time'}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={clear}>
                  <X className="h-3.5 w-3.5" />
                  Clear
                </Button>
                <Button size="sm" disabled={!complete} onClick={apply}>
                  Apply
                </Button>
              </div>
            </div>

            {showTime && (
              <div className="flex items-center gap-2 text-sm">
                <span className="w-10 text-muted-foreground">Start</span>
                <Input
                  type="time"
                  aria-label="Start time"
                  className="h-9 w-[7rem]"
                  value={draft.fromTime ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, fromTime: e.target.value || undefined }))
                  }
                />
                <span className="ml-2 w-8 text-muted-foreground">End</span>
                <Input
                  type="time"
                  aria-label="End time"
                  className="h-9 w-[7rem]"
                  value={draft.toTime ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, toTime: e.target.value || undefined }))}
                />
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
