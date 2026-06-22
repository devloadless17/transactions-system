import { AdminWhishView } from '@/features/admin/whish/admin-whish-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function AdminWhishPage() {
  // Prefetch the primary payments list (page 1) so the table renders populated
  // on first paint instead of flashing the client loading skeleton.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'whish', 'payments', { page: 1 }],
        path: '/admin/whish/payments?page=1&pageSize=20',
      },
    ],
    <AdminWhishView />,
  );
}
