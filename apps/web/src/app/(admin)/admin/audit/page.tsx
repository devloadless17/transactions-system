import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { AuditLogsView } from '@/features/admin/audit/audit-logs-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireRole(FULL_ADMIN_ROLES);
  // Prefetch the default audit-logs list (page 1, no filters) so the table
  // paints populated instead of flashing a loading skeleton on first paint.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'audit-logs', 'page=1&pageSize=50'],
        path: '/admin/audit-logs?page=1&pageSize=50',
      },
    ],
    <AuditLogsView />,
  );
}
