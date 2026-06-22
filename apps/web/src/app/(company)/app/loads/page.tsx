import { WithdrawalsView } from '@/features/company/withdrawals-view';
import { LOAD_CONFIG, defaultListPrefetch } from '@/features/company/process-configs';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return withListPrefetch(
    [defaultListPrefetch(LOAD_CONFIG)],
    <WithdrawalsView config={LOAD_CONFIG} />,
  );
}
