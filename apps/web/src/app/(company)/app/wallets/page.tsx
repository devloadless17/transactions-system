import { WalletsView } from '@/features/company/wallets-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Server-prefetch the wallets list so the table renders populated on first
  // paint (no client loading flash).
  return withListPrefetch(
    [{ queryKey: ['company', 'wallets'], path: '/company/wallets' }],
    <WalletsView />,
  );
}
