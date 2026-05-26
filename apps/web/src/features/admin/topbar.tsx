'use client';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { MeResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { apiFetch } from '@/lib/api.client';

export function AdminTopbar({ session }: { session: MeResponse }) {
  const router = useRouter();

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
    <header className="flex h-14 items-center justify-between border-b bg-background px-6">
      <div className="text-sm text-muted-foreground">
        Signed in as {session.email} · {session.role}
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
