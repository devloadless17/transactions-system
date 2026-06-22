import { WithdrawalsView } from '@/features/company/withdrawals-view';
import { PAYOUT_CONFIG, defaultListPrefetch } from '@/features/company/process-configs';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return withListPrefetch(
    [defaultListPrefetch(PAYOUT_CONFIG)],
    <WithdrawalsView config={PAYOUT_CONFIG} />,
  );
}
