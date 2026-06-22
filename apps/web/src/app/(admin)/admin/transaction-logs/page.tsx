import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { TransactionLogsView } from '@/features/admin/transaction-logs/transaction-logs-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireRole(FULL_ADMIN_ROLES);
  // Prefetch the default logs list (page 1, no filters) so the table paints populated on first load.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'transaction-logs', 'page=1&pageSize=50'],
        path: '/admin/transaction-logs?page=1&pageSize=50',
      },
    ],
    <TransactionLogsView />,
  );
}
