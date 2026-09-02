'use client';
import { Search } from 'lucide-react';
import { WhishPaymentStatus } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { isoBound, quickRangePresets } from '@/lib/date-presets';
import { CompanyFilter } from '@/features/admin/company-filter';

// Shared filter bar for the Whish Pay lists (company + admin). Every field maps
// to a backend-supported query param; the SAME params feed both the list query
// and the CSV export so an export always matches what's on screen. `search` is
// kept separate from the structured filters so the view can debounce it.
export interface WhishFilters {
  status: WhishPaymentStatus | '';
  needsAttention: boolean; // admin-only
  companyId: string; // admin-only
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  fromTime?: string; // HH:mm (optional; whole-day window when absent)
  toTime?: string; // HH:mm
}

export const EMPTY_WHISH_FILTERS: WhishFilters = {
  status: '',
  needsAttention: false,
  companyId: '',
  from: '',
  to: '',
  fromTime: undefined,
  toTime: undefined,
};

/** Build the list/export query string from the active filters + search (+ base params). */
export function whishFilterParams(
  f: WhishFilters,
  search: string,
  base: Record<string, string>,
): URLSearchParams {
  const p = new URLSearchParams(base);
  if (f.status) p.set('status', f.status);
  if (f.needsAttention) p.set('needsAttention', 'true');
  if (f.companyId) p.set('companyId', f.companyId);
  const s = search.trim();
  if (s) p.set('search', s);
  if (f.from) {
    const iso = isoBound(f.from, f.fromTime, false);
    if (iso) p.set('from', iso);
  }
  if (f.to) {
    const iso = isoBound(f.to, f.toTime, true);
    if (iso) p.set('to', iso);
  }
  return p;
}

/** True when any filter or the search box is set (drives the Clear button). */
export function whishFiltersActive(f: WhishFilters, search: string): boolean {
  return Boolean(search.trim() || f.status || f.needsAttention || f.companyId || f.from || f.to);
}

export function WhishFilterBar({
  value,
  onChange,
  search,
  onSearchChange,
  showCompanyFilter,
  showNeedsAttention,
}: {
  value: WhishFilters;
  onChange: (f: WhishFilters) => void;
  search: string;
  onSearchChange: (s: string) => void;
  /** Admin-only: filter to one company. */
  showCompanyFilter?: boolean;
  /** Admin-only: filter to paid-but-unsettled (needs-attention) payments. */
  showNeedsAttention?: boolean;
}) {
  const set = (patch: Partial<WhishFilters>) => onChange({ ...value, ...patch });
  const selectClass =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto';
  const active = whishFiltersActive(value, search);
  // WhishFilters store cleared bounds as '' (not undefined) — the shared matcher
  // normalises before comparing, so "All time" highlights correctly here too.
  const datePresets = quickRangePresets(value, (b) =>
    set({ from: b.from ?? '', to: b.to ?? '', fromTime: undefined, toTime: undefined }),
  );

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-full space-y-1 sm:w-72">
          <Label className="text-xs">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search invoice, phone, or reference…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>
        <Field label="Status">
          <select
            className={selectClass}
            value={value.status}
            onChange={(e) => set({ status: (e.target.value as WhishPaymentStatus) || '' })}
          >
            <option value="">All</option>
            {Object.values(WhishPaymentStatus).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {showNeedsAttention && (
          <Field label="Attention">
            <select
              className={selectClass}
              value={value.needsAttention ? 'true' : ''}
              onChange={(e) => set({ needsAttention: e.target.value === 'true' })}
            >
              <option value="">All</option>
              <option value="true">Needs attention</option>
            </select>
          </Field>
        )}
        {showCompanyFilter && (
          <Field label="Company">
            <CompanyFilter value={value.companyId} onChange={(companyId) => set({ companyId })} />
          </Field>
        )}
        <Field label="Date">
          <DateRangePicker
            value={{
              from: value.from || undefined,
              to: value.to || undefined,
              fromTime: value.fromTime,
              toTime: value.toTime,
            }}
            onChange={(v) =>
              set({
                from: v.from ?? '',
                to: v.to ?? '',
                fromTime: v.fromTime,
                toTime: v.toTime,
              })
            }
            presets={datePresets}
            align="end"
            placeholder="All time"
          />
        </Field>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(EMPTY_WHISH_FILTERS);
              onSearchChange('');
            }}
          >
            Clear
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
