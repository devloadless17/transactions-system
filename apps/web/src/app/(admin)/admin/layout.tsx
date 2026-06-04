import { ADMIN_ROLES } from '@app/shared';
import { requireRole } from '@/lib/session';
import { AdminSidebar } from '@/features/admin/sidebar';
import { AdminTopbar } from '@/features/admin/topbar';
import { RealtimeBridge } from '@/lib/realtime';
import { SessionKeepAlive } from '@/lib/session-keep-alive';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Any platform admin (incl. BACKOFFICE) may enter; the narrower page access is
  // enforced per-page below and by nav filtering keyed off session.role.
  const session = await requireRole(ADMIN_ROLES);

  return (
    <div className="flex min-h-screen">
      <RealtimeBridge />
      <SessionKeepAlive />
      <AdminSidebar role={session.role} />
      <div className="flex flex-1 flex-col">
        <AdminTopbar session={session} />
        <main className="min-w-0 flex-1 bg-muted/20 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
