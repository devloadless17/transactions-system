'use client';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ActivityKind, AuditLogResponse, PaginatedResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { CompanyFilter, useCompanyNames } from '@/features/admin/company-filter';
import { auditEntityTarget, EntityDetailDrawer } from '@/features/activity/activity-detail-drawer';

const PAGE_SIZE = 50;

interface State {
  page: number;
  entityType: string;
  action: string;
  companyId: string;
}

function stateFromParams(p: URLSearchParams): State {
  return {
    page: Number(p.get('page')) || 1,
    entityType: p.get('entityType') ?? '',
    action: p.get('action') ?? '',
    companyId: p.get('companyId') ?? '',
  };
}

// URL query string mirroring the state. Defaults (page 1, empty filters) are
// omitted to keep the URL clean and comparisons stable.
function paramsFromState(s: State): string {
  const p = new URLSearchParams();
  if (s.page > 1) p.set('page', String(s.page));
  if (s.entityType) p.set('entityType', s.entityType);
  if (s.action) p.set('action', s.action);
  if (s.companyId) p.set('companyId', s.companyId);
  return p.toString();
}

export function AuditLogsView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlString = searchParams.toString();

  // State is initialised from the URL on mount (shareable/bookmarkable links).
  const [state, setState] = useState<State>(() => stateFromParams(searchParams));
  // The money operation whose detail drawer is open (clicked from an entity cell).
  const [entityTarget, setEntityTarget] = useState<{ kind: ActivityKind; id: string } | null>(null);

  // Single writer: update state AND push it to the URL together (replace, so we
  // don't pollute history on every keystroke). Because state and URL end up in
  // sync, the read-back effect below stays a no-op afterwards — no loop.
  function update(patch: Partial<State>) {
    const next = { ...state, ...patch };
    setState(next);
    const qs = paramsFromState(next);
    // Native replaceState (Next integrates it with useSearchParams) instead of
    // router.replace: on a force-dynamic page router.replace re-runs the whole RSC
    // tree per keystroke. State already drives the (debounced) query; the URL is
    // only for share/Back-Forward, so it never needs a server roundtrip.
    window.history.replaceState(null, '', pathname + (qs ? `?${qs}` : ''));
  }

  // Read-back: when the URL changes externally (Back/Forward), adopt it into
  // state. Guarded by equality so our own writes don't trigger a re-sync.
  useEffect(() => {
    if (urlString !== paramsFromState(state)) {
      setState(stateFromParams(new URLSearchParams(urlString)));
    }
    // We intentionally depend only on the URL string; `state` is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlString]);

  // Debounce the free-text filters into the query key only; inputs stay live.
  const debouncedEntityType = useDebouncedValue(state.entityType, 300);
  const debouncedAction = useDebouncedValue(state.action, 300);

  const params = new URLSearchParams({ page: String(state.page), pageSize: String(PAGE_SIZE) });
  if (debouncedEntityType) params.set('entityType', debouncedEntityType);
  if (debouncedAction) params.set('action', debouncedAction);
  if (state.companyId) params.set('companyId', state.companyId);

  const listQ = useQuery({
    queryKey: ['admin', 'audit-logs', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<AuditLogResponse>>(`/admin/audit-logs?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const companyNames = useCompanyNames(listQ.data?.data.map((r) => r.companyId) ?? []);
  const companyName = (id: string | null) => (!id ? '—' : (companyNames.get(id) ?? id.slice(0, 8)));

  const columns: Column<AuditLogResponse>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'text-xs text-muted-foreground',
      cell: (a) => new Date(a.createdAt).toLocaleString(),
    },
    { key: 'actor', header: 'Actor', cell: (a) => a.actorEmail ?? '—' },
    { key: 'company', header: 'Company', cell: (a) => companyName(a.companyId) },
    {
      key: 'action',
      header: 'Action',
      className: 'font-mono text-xs',
      cell: (a) => a.action,
    },
    {
      key: 'entity',
      header: 'Entity',
      className: 'font-mono text-xs',
      cell: (a) => {
        const label = `${a.entityType}${a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}`;
        // Deposits/withdrawals/payouts/loads open their full detail in place, so
        // an operator can jump from an audit entry straight to the transaction.
        const target = auditEntityTarget(a.entityType, a.entityId);
        return target ? (
          <button
            type="button"
            onClick={() => setEntityTarget(target)}
            className="text-primary underline-offset-2 hover:underline"
            title="View full details"
          >
            {label}
          </button>
        ) : (
          <span>{label}</span>
        );
      },
    },
    {
      key: 'ip',
      header: 'IP',
      className: 'text-xs text-muted-foreground',
      cell: (a) => a.ipAddress ?? '—',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">Immutable record of mutating operations.</p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Entity type</Label>
              <Input
                placeholder="company"
                value={state.entityType}
                onChange={(e) => update({ entityType: e.target.value, page: 1 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Action</Label>
              <Input
                placeholder="company.created"
                value={state.action}
                onChange={(e) => update({ action: e.target.value, page: 1 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Company</Label>
              <CompanyFilter
                value={state.companyId}
                onChange={(id) => update({ companyId: id, page: 1 })}
                className="w-full"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<AuditLogResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(a) => a.id}
            empty={<div className="py-8 text-center text-muted-foreground">No audit logs yet.</div>}
          />
        </CardContent>
      </Card>

      {listQ.data && (
        <Pagination
          page={listQ.data.meta.page}
          total={listQ.data.meta.total}
          totalPages={listQ.data.meta.totalPages}
          onPageChange={(p) => update({ page: p })}
        />
      )}

      <EntityDetailDrawer
        scope="admin"
        target={entityTarget}
        onClose={() => setEntityTarget(null)}
      />
    </div>
  );
}
