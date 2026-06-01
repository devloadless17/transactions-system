import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { AdminSidebar } from '@/features/admin/sidebar';
import { AdminTopbar } from '@/features/admin/topbar';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole([UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR]);

  return (
    <div className="flex min-h-screen">
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <AdminTopbar session={session} />
        <main className="min-w-0 flex-1 bg-muted/20 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
