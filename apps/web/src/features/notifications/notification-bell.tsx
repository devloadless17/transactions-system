'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  CheckCheck,
  HandCoins,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { NotificationFlow, NotificationListResponse, NotificationResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiFetch } from '@/lib/api.client';
import { cn } from '@/lib/cn';
import { NOTIF_MUTE_KEY, useNotificationSound } from './use-notification-sound';
import { notificationTime } from './time';

const FLOW_ICON: Record<NotificationFlow, typeof ArrowUpFromLine> = {
  WITHDRAWAL: ArrowUpFromLine,
  PAYOUT: HandCoins,
  LOAD: ArrowDownToLine,
  // Admin alerts about a deposit (e.g. a source re-sent one with another amount).
  DEPOSIT: AlertTriangle,
};

export function NotificationBell({ scope }: { scope: 'admin' | 'company' }) {
  const qc = useQueryClient();
  const router = useRouter();
  const allHref = scope === 'admin' ? '/admin/notifications' : '/app/notifications';
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const play = useNotificationSound();
  const prevUnread = useRef<number | null>(null);

  useEffect(() => {
    try {
      setMuted(window.localStorage.getItem(NOTIF_MUTE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const q = useQuery({
    queryKey: ['notifications', 'active'],
    queryFn: () => apiFetch<NotificationListResponse>('/notifications?filter=active&pageSize=8'),
    // The realtime 'notifications' topic keeps the bell live; this is just a slow
    // backstop so it can't silently go stale if the socket is down on a long-lived
    // focused tab. Never poll a hidden/blurred tab.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    // Ambient topbar widget — must not drive the top progress bar (see TopProgressBar).
    meta: { background: true },
  });
  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.data ?? [];

  // Ring whenever the unread count climbs (a new notification arrived live).
  useEffect(() => {
    const prev = prevUnread.current;
    if (prev !== null && unread > prev) play();
    prevUnread.current = unread;
  }, [unread, play]);

  // Optimistic mutations: patch ONLY the bell's exact cache key so read/dismiss/
  // clear feel instant. We deliberately do NOT touch the broad ['notifications']
  // queries (the notifications-view 'unread'/'cleared' tabs); the onSettled
  // invalidate refreshes all of them authoritatively, and rollback restores the
  // bell on error.
  const BELL_KEY = ['notifications', 'active'] as const;
  function useOptimisticNotif<TVars>(opts: {
    mutationFn: (v: TVars) => Promise<unknown>;
    patch: (prev: NotificationListResponse, v: TVars) => NotificationListResponse;
  }) {
    return useMutation({
      mutationFn: opts.mutationFn,
      onMutate: async (v: TVars) => {
        await qc.cancelQueries({ queryKey: BELL_KEY });
        const prev = qc.getQueryData<NotificationListResponse>(BELL_KEY);
        if (prev) qc.setQueryData<NotificationListResponse>(BELL_KEY, opts.patch(prev, v));
        return { prev };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(BELL_KEY, ctx.prev);
      },
      onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    });
  }

  const markRead = useOptimisticNotif<string>({
    mutationFn: (id) => apiFetch(`/notifications/${id}/read`, { method: 'POST' }),
    patch: (prev, id) => {
      const wasUnread = prev.data.some((n) => n.id === id && !n.read);
      return {
        ...prev,
        data: prev.data.map((n) => (n.id === id ? { ...n, read: true } : n)),
        unreadCount: wasUnread ? Math.max(0, prev.unreadCount - 1) : prev.unreadCount,
      };
    },
  });
  const markAll = useOptimisticNotif<void>({
    mutationFn: () => apiFetch('/notifications/read-all', { method: 'POST' }),
    patch: (prev) => ({
      ...prev,
      data: prev.data.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }),
  });
  const dismiss = useOptimisticNotif<string>({
    mutationFn: (id) => apiFetch(`/notifications/${id}/dismiss`, { method: 'POST' }),
    patch: (prev, id) => {
      // Dismiss writes a read row, so an UNREAD item leaving also clears the badge.
      const wasUnread = prev.data.some((n) => n.id === id && !n.read);
      return {
        ...prev,
        data: prev.data.filter((n) => n.id !== id),
        unreadCount: wasUnread ? Math.max(0, prev.unreadCount - 1) : prev.unreadCount,
      };
    },
  });
  const clearAll = useOptimisticNotif<void>({
    mutationFn: () => apiFetch('/notifications/clear-all', { method: 'POST' }),
    patch: (prev) => ({ ...prev, data: [], unreadCount: 0 }),
  });

  function openItem(n: NotificationResponse) {
    // Company notifications are purely informational: opening one means the user
    // has now seen it, so clear it (it deep-links to the item's detail panel).
    // Admin notifications are work items — opening one only marks it read; it's
    // cleared when the request is actually handled (approve/reject) server-side.
    if (scope === 'company') dismiss.mutate(n.id);
    else if (!n.read) markRead.mutate(n.id);
    setOpen(false);
    router.push(n.link);
  }

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      try {
        window.localStorage.setItem(NOTIF_MUTE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      // Play a confirmation chime when turning sound ON.
      if (!next) play({ force: true });
      return next;
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={toggleMute}
              title={muted ? 'Unmute (and test) sound' : 'Mute sound'}
              aria-label={muted ? 'Unmute notification sound' : 'Mute notification sound'}
            >
              {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => play({ force: true })}
              title="Test sound"
              aria-label="Play a test notification sound"
            >
              <Bell className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending || unread === 0}
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => clearAll.mutate()}
              disabled={clearAll.isPending}
            >
              Clear all
            </button>
          </div>
        )}

        <ul className="max-h-80 overflow-auto">
          {items.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground">
              {q.isLoading ? 'Loading…' : "You're all caught up"}
            </li>
          ) : (
            items.map((n) => {
              const Icon = FLOW_ICON[n.flow];
              return (
                <li key={n.id} className="group relative border-b last:border-0">
                  <button
                    type="button"
                    onClick={() => openItem(n)}
                    className={cn(
                      'flex w-full gap-3 px-3 py-2.5 pr-8 text-left transition-colors hover:bg-accent',
                      !n.read && 'bg-primary/5',
                    )}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{n.title}</span>
                        {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {notificationTime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss.mutate(n.id)}
                    title="Clear"
                    aria-label="Clear notification"
                    className="absolute right-1.5 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <Link
          href={allHref}
          onClick={() => setOpen(false)}
          className="block border-t px-3 py-2 text-center text-xs font-medium text-primary hover:underline"
        >
          View all notifications
        </Link>
      </PopoverContent>
    </Popover>
  );
}
