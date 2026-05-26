import { WithdrawalsView } from '@/features/company/withdrawals-view';
import { LOAD_CONFIG } from '@/features/company/process-configs';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <WithdrawalsView config={LOAD_CONFIG} />;
}
