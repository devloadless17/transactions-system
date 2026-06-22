import { LedgerView } from '@/features/company/ledger-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Prefetch the default ledger list (page 1, no filters) so the table renders
  // populated on first paint instead of flashing a loading skeleton.
  return withListPrefetch(
    [
      {
        queryKey: ['company', 'ledger', 'page=1&pageSize=50'],
        path: '/company/ledger?page=1&pageSize=50',
      },
    ],
    <LedgerView />,
  );
}
