'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  CheckCheck,
  HandCoins,
  X,
} from 'lucide-react';
import type { NotificationFlow, NotificationListResponse, NotificationResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/empty-state';
import { apiFetch } from '@/lib/api.client';
import { cn } from '@/lib/cn';
import { notificationTime } from './time';

const FLOW_ICON: Record<NotificationFlow, typeof ArrowUpFromLine> = {
  WITHDRAWAL: ArrowUpFromLine,
  PAYOUT: HandCoins,
  LOAD: ArrowDownToLine,
  // Admin alerts about a deposit (e.g. a source re-sent one with another amount).
  DEPOSIT: AlertTriangle,
};

type Filter = 'active' | 'unread' | 'cleared';
const TABS: Array<{ value: Filter; label: string }> = [
  { value: 'active', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'cleared', label: 'Cleared' },
];

const PAGE_SIZE = 20;

/** Full notification history: paginated, filterable (All / Unread / Cleared). */
export function NotificationsView({ scope }: { scope: 'admin' | 'company' }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('active');
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ['notifications', filter, page],
    queryFn: () =>
      apiFetch<NotificationListResponse>(
        `/notifications?filter=${filter}&page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.data ?? [];
  const meta = q.data?.meta;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => apiFetch('/notifications/read-all', { method: 'POST' }),
    onSuccess: invalidate,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${id}/dismiss`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const clearAll = useMutation({
    mutationFn: () => apiFetch('/notifications/clear-all', { method: 'POST' }),
    onSuccess: invalidate,
  });

  function setTab(f: Filter) {
    setFilter(f);
    setPage(1);
  }
  function openItem(n: NotificationResponse) {
    // Company notifications are informational — opening one means it's been seen,
    // so clear it (unless we're already viewing the Cleared tab). Admin items are
    // work items: opening only marks read; they clear when handled server-side.
    if (scope === 'company' && filter !== 'cleared') dismiss.mutate(n.id);
    else if (!n.read) markRead.mutate(n.id);
    router.push(n.link);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {scope === 'admin'
              ? 'Requests to action and recent activity across the platform.'
              : 'Updates on your withdrawals, payouts and loads.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => markAll.mutate()}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
          <Button variant="outline" size="sm" onClick={() => clearAll.mutate()}>
            Clear all
          </Button>
        </div>
      </div>

      <div className="inline-flex rounded-md border p-0.5">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={cn(
              'rounded px-3 py-1 text-sm font-medium transition-colors',
              filter === t.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="px-6 py-12 text-center text-sm text-destructive">
              Couldn&apos;t load notifications — retrying…
            </div>
          ) : items.length === 0 && !q.isLoading ? (
            <EmptyState
              icon={BellOff}
              title={filter === 'cleared' ? 'Nothing cleared' : 'No notifications'}
              description={
                filter === 'unread'
                  ? 'No unread notifications.'
                  : 'Notifications will show up here.'
              }
            />
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const Icon = FLOW_ICON[n.flow];
                return (
                  <li key={n.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => openItem(n)}
                      className={cn(
                        'flex w-full gap-4 px-4 py-3 pr-12 text-left transition-colors hover:bg-accent sm:px-6',
                        !n.read && 'bg-primary/5',
                      )}
                    >
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-medium">{n.title}</span>
                          {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                        </span>
                        <span className="block text-sm text-muted-foreground">{n.body}</span>
                        <span className="block text-xs text-muted-foreground">
                          {notificationTime(n.createdAt)}
                        </span>
                      </span>
                    </button>
                    {filter !== 'cleared' && (
                      <button
                        type="button"
                        onClick={() => dismiss.mutate(n.id)}
                        title="Clear"
                        aria-label="Clear notification"
                        className="absolute right-3 top-3 rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100 sm:right-5"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {meta && (
        <Pagination
          page={meta.page}
          totalPages={meta.totalPages}
          total={meta.total}
          pageSize={meta.pageSize}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
