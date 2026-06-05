import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { TransactionLogsView } from '@/features/admin/transaction-logs/transaction-logs-view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireRole(FULL_ADMIN_ROLES);
  return <TransactionLogsView />;
}
