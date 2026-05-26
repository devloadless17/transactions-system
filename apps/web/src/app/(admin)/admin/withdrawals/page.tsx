import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import { ADMIN_WITHDRAWAL_CONFIG } from '@/features/admin/withdrawals/process-configs';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <AdminWithdrawalsView config={ADMIN_WITHDRAWAL_CONFIG} />;
}
