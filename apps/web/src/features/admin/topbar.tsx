'use client';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import type { MeResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { MobileNav } from '@/components/nav/mobile-nav';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { usePendingCounts } from '@/features/operations/use-pending-counts';
import { apiFetch } from '@/lib/api.client';
import { adminNavItemsFor } from './sidebar';

export function AdminTopbar({ session }: { session: MeResponse }) {
  const router = useRouter();
  const badges = usePendingCounts('admin');

  async function handleLogout() {
    try {
      await apiFetch<void>('/auth/logout', { method: 'POST' });
    } catch {
      // best effort
    }
    toast.success('Signed out');
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b bg-background px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav items={adminNavItemsFor(session.role)} badges={badges} />
        <div className="hidden truncate text-sm text-muted-foreground sm:block">
          Signed in as {session.email} · {session.role}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <NotificationBell scope="admin" />
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
