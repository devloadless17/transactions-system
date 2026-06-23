'use client';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { PaginatedResponse, TransactionLogKind, TransactionLogResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { apiFetch } from '@/lib/api.client';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { CompanyFilter, useCompanyNames } from '@/features/admin/company-filter';

const PAGE_SIZE = 50;
const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm';

interface State {
  page: number;
  kind: string;
  success: string;
  companyId: string;
  search: string;
}

function stateFromParams(p: URLSearchParams): State {
  return {
    page: Number(p.get('page')) || 1,
    kind: p.get('kind') ?? '',
    success: p.get('success') ?? '',
    companyId: p.get('companyId') ?? '',
    search: p.get('search') ?? '',
  };
}

function paramsFromState(s: State): string {
  const p = new URLSearchParams();
  if (s.page > 1) p.set('page', String(s.page));
  if (s.kind) p.set('kind', s.kind);
  if (s.success) p.set('success', s.success);
  if (s.companyId) p.set('companyId', s.companyId);
  if (s.search) p.set('search', s.search);
  return p.toString();
}

const KIND_LABEL: Record<TransactionLogKind, string> = {
  WHISH_LINK: 'Whish link',
  INGEST: 'Ingest',
};

export function TransactionLogsView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlString = searchParams.toString();

  const [state, setState] = useState<State>(() => stateFromParams(searchParams));
  const [selected, setSelected] = useState<TransactionLogResponse | null>(null);

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

  useEffect(() => {
    if (urlString !== paramsFromState(state)) {
      setState(stateFromParams(new URLSearchParams(urlString)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlString]);

  const debouncedSearch = useDebouncedValue(state.search, 300);

  const params = new URLSearchParams({ page: String(state.page), pageSize: String(PAGE_SIZE) });
  if (state.kind) params.set('kind', state.kind);
  if (state.success) params.set('success', state.success);
  if (state.companyId) params.set('companyId', state.companyId);
  if (debouncedSearch) params.set('search', debouncedSearch);

  const listQ = useQuery({
    queryKey: ['admin', 'transaction-logs', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<TransactionLogResponse>>(
        `/admin/transaction-logs?${params.toString()}`,
      ),
  });

  const companyNames = useCompanyNames(listQ.data?.data.map((r) => r.companyId) ?? []);
  const companyName = (id: string | null) => (!id ? '—' : (companyNames.get(id) ?? id.slice(0, 8)));

  const columns: Column<TransactionLogResponse>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'text-xs text-muted-foreground whitespace-nowrap',
      cell: (l) => new Date(l.createdAt).toLocaleString(),
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (l) => (
        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium">
          {KIND_LABEL[l.kind]}
        </span>
      ),
    },
    { key: 'company', header: 'Company', cell: (l) => companyName(l.companyId) },
    {
      key: 'source',
      header: 'Source',
      className: 'font-mono text-xs',
      cell: (l) => l.sourceCode ?? '—',
    },
    {
      key: 'reference',
      header: 'Reference',
      className: 'font-mono text-xs',
      cell: (l) => l.reference ?? '—',
    },
    {
      key: 'result',
      header: 'Result',
      className: 'whitespace-nowrap text-xs font-medium',
      cell: (l) => (
        <span className={l.success ? 'text-green-600' : 'text-red-600'}>
          {l.success ? 'OK' : 'FAIL'} · {l.statusCode}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Transaction Logs</h1>
        <p className="text-sm text-muted-foreground">
          Request &amp; response for every Whish payment-link generation and every source ingest
          call. Click a row to see the full payloads.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">Kind</Label>
              <select
                className={SELECT_CLASS}
                value={state.kind}
                onChange={(e) => update({ kind: e.target.value, page: 1 })}
              >
                <option value="">All</option>
                <option value="WHISH_LINK">Whish link</option>
                <option value="INGEST">Ingest</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Result</Label>
              <select
                className={SELECT_CLASS}
                value={state.success}
                onChange={(e) => update({ success: e.target.value, page: 1 })}
              >
                <option value="">All</option>
                <option value="true">Success</option>
                <option value="false">Failed</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reference</Label>
              <Input
                placeholder="external id"
                value={state.search}
                onChange={(e) => update({ search: e.target.value, page: 1 })}
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
          <DataTable<TransactionLogResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(l) => l.id}
            onRowClick={(l) => setSelected(l)}
            empty={<div className="py-8 text-center text-muted-foreground">No logs yet.</div>}
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

      <LogDetail log={selected} companyName={companyName} onClose={() => setSelected(null)} />
    </div>
  );
}

function LogDetail({
  log,
  companyName,
  onClose,
}: {
  log: TransactionLogResponse | null;
  companyName: (id: string | null) => string;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!log} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{log ? KIND_LABEL[log.kind] : ''}</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {log?.reference ?? log?.id}
          </SheetDescription>
        </SheetHeader>
        {log && (
          <div className="mt-4 space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Meta label="When" value={new Date(log.createdAt).toLocaleString()} />
              <Meta
                label="Result"
                value={
                  <span className={log.success ? 'text-green-600' : 'text-red-600'}>
                    {log.success ? 'OK' : 'FAIL'} · {log.statusCode}
                  </span>
                }
              />
              <Meta label="Company" value={companyName(log.companyId)} />
              <Meta label="Source" value={log.sourceCode ?? '—'} />
              {log.transactionId && (
                <Meta
                  label="Transaction"
                  value={<span className="font-mono text-xs">{log.transactionId}</span>}
                />
              )}
            </dl>
            <JsonBlock title="Request" value={log.request} />
            <JsonBlock title="Response" value={log.response} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{title}</p>
      <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
        {value == null ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
