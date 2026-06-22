import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import {
  ADMIN_PAYOUT_CONFIG,
  defaultListPrefetch,
} from '@/features/admin/withdrawals/process-configs';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return withListPrefetch(
    [defaultListPrefetch(ADMIN_PAYOUT_CONFIG)],
    <AdminWithdrawalsView config={ADMIN_PAYOUT_CONFIG} />,
  );
}
