import { WithdrawalsView } from '@/features/company/withdrawals-view';
import { WITHDRAWAL_CONFIG, defaultListPrefetch } from '@/features/company/process-configs';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Server-prefetch the first page of withdrawals so the table renders populated
  // on first paint (no client loading flash).
  return withListPrefetch(
    [defaultListPrefetch(WITHDRAWAL_CONFIG)],
    <WithdrawalsView config={WITHDRAWAL_CONFIG} />,
  );
}
