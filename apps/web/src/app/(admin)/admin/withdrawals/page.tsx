import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import {
  ADMIN_WITHDRAWAL_CONFIG,
  defaultListPrefetch,
} from '@/features/admin/withdrawals/process-configs';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return withListPrefetch(
    [defaultListPrefetch(ADMIN_WITHDRAWAL_CONFIG)],
    <AdminWithdrawalsView config={ADMIN_WITHDRAWAL_CONFIG} />,
  );
}
