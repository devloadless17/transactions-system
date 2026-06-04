'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import type { CompanyResponse, PaginatedResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api.client';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/cn';

/**
 * Resolve company names for a specific set of ids (e.g. the rows on the current
 * page) — instead of fetching the whole company list just to label a screenful
 * of rows. Returns id -> name. Re-fetches only when the id set changes.
 */
export function useCompanyNames(ids: Array<string | null | undefined>): Map<string, string> {
  const unique = useMemo(
    () => Array.from(new Set(ids.filter((x): x is string => !!x))).sort(),
    [ids],
  );
  const key = unique.join(',');
  const q = useQuery({
    queryKey: ['admin', 'companies', 'names', key],
    queryFn: () =>
      apiFetch<PaginatedResponse<CompanyResponse>>(
        `/admin/companies?ids=${encodeURIComponent(key)}&pageSize=100`,
      ),
    enabled: unique.length > 0,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const c of q.data?.data ?? []) m.set(c.id, c.name);
    return m;
  }, [q.data]);
}

/**
 * Searchable, lazy company picker for admin filters. Fetches a handful of
 * matches server-side as you type (only when open) — it never bulk-loads the
 * full company list. `value` is a company id or '' (= All).
 */
export function CompanyFilter({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (companyId: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 250);

  // Results to choose from (only fetched while the popover is open).
  const resultsQ = useQuery({
    queryKey: ['admin', 'companies', 'picker', debounced],
    queryFn: () =>
      apiFetch<PaginatedResponse<CompanyResponse>>(
        `/admin/companies?pageSize=10${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`,
      ),
    enabled: open,
  });
  // Name for the currently-selected id (so the trigger shows it, not the uuid).
  const selectedName = useCompanyNames([value]).get(value);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={cn('h-9 justify-between gap-2 font-normal sm:w-56', className)}
        >
          <span className="truncate">
            {value ? (
              (selectedName ?? '…')
            ) : (
              <span className="text-muted-foreground">All companies</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 opacity-50" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies…"
            className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <ul className="max-h-64 overflow-auto p-1">
          <li>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => pick('')}
            >
              All companies
              {!value && <Check className="h-4 w-4" />}
            </button>
          </li>
          {resultsQ.isLoading && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</li>
          )}
          {!resultsQ.isLoading && (resultsQ.data?.data.length ?? 0) === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">No matches</li>
          )}
          {resultsQ.data?.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => pick(c.id)}
              >
                <span className="truncate">{c.name}</span>
                {value === c.id && <Check className="h-4 w-4 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
