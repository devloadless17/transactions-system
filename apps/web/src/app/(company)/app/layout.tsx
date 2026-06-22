import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { CompanySidebar } from '@/features/company/sidebar';
import { CompanyTopbar } from '@/features/company/topbar';
import { RealtimeBridge } from '@/lib/realtime.lazy';
import { SessionKeepAlive } from '@/lib/session-keep-alive';

export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole([
    UserRole.COMPANY_OWNER,
    UserRole.COMPANY_MANAGER,
    UserRole.COMPANY_VIEWER,
  ]);

  return (
    <div className="flex min-h-screen">
      <RealtimeBridge />
      <SessionKeepAlive />
      <CompanySidebar />
      <div className="flex flex-1 flex-col">
        <CompanyTopbar session={session} />
        <main className="min-w-0 flex-1 bg-muted/20 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
