'use client';
import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search, X } from 'lucide-react';
import type { CompanyResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Pick the companies a commission rule applies to. "All companies" (the empty
 * selection) means a single global rule; otherwise the rule targets exactly the
 * chosen companies. Filters the already-loaded company list client-side.
 */
export function CompanyMultiSelect({
  companies,
  value,
  onChange,
}: {
  companies: CompanyResponse[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const nameById = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? companies.filter((c) => c.name.toLowerCase().includes(q)) : companies;
    return list.slice(0, 50);
  }, [companies, search]);

  const allCompanies = value.length === 0;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            className="h-10 w-full justify-between gap-2 font-normal"
          >
            <span className="truncate">
              {allCompanies ? (
                <span className="text-muted-foreground">All companies</span>
              ) : (
                `${value.length} ${value.length === 1 ? 'company' : 'companies'} selected`
              )}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
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
                onClick={() => onChange([])}
              >
                All companies
                {allCompanies && <Check className="h-4 w-4" />}
              </button>
            </li>
            {filtered.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">No matches</li>
            )}
            {filtered.map((c) => {
              const selected = value.includes(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => toggle(c.id)}
                  >
                    <span className="truncate">{c.name}</span>
                    {selected && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>

      {!allCompanies && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1 pr-1">
              {nameById.get(id) ?? id}
              <button
                type="button"
                aria-label="Remove"
                className="rounded-sm hover:bg-muted-foreground/20"
                onClick={() => toggle(id)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
