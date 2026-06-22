import { WhishView } from '@/features/company/whish-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function WhishPage() {
  // Prefetch the first page of Whish payments so the table renders populated on first paint.
  return withListPrefetch(
    [
      {
        queryKey: ['company', 'whish', { page: 1 }],
        path: '/company/whish/payments?page=1&pageSize=20',
      },
    ],
    <WhishView />,
  );
}
