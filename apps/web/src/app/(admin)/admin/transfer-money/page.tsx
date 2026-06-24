import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { TransferMoneyView } from '@/features/admin/transfer-money/transfer-money-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function AdminTransferMoneyPage() {
  // Sending money out of the platform's Whish account is SUPER_ADMIN-only at the
  // API; gate the page to match so other admins aren't sent to a page that 403s.
  await requireRole([UserRole.SUPER_ADMIN]);
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'whish', 'transfers', { page: 1 }],
        path: '/admin/whish/transfers?page=1&pageSize=20',
      },
    ],
    <TransferMoneyView />,
  );
}
