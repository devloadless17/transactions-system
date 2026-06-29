// Per-process configs for the admin Withdraw / Payout / Load review pages.
import type { AdminProcessConfig } from './withdrawals-view';
import type { ListPrefetch } from '@/lib/prefetch';

/**
 * Descriptor for AdminWithdrawalsView's initial list query — page 1, pageSize 20,
 * no filters. MUST stay in sync with the admin withdrawals-view.tsx
 * (`flowFilterParams(EMPTY_FLOW_FILTERS, { pageSize: '20', page: '1' })` → key
 * `[...queryKey, '<qs>']`, NOTE: no 'list' segment). Lives in this non-'use
 * client' module so the server page can import it.
 */
export function defaultListPrefetch(config: AdminProcessConfig): ListPrefetch {
  const qs = 'pageSize=20&page=1';
  return { queryKey: [...config.queryKey, qs], path: `${config.listEndpoint}?${qs}` };
}

export const ADMIN_WITHDRAWAL_CONFIG: AdminProcessConfig = {
  listEndpoint: '/admin/withdrawals',
  queryKey: ['admin', 'withdrawals'],
  heading: 'Withdrawals',
  subhead:
    'Review pending withdrawals. Send the money out-of-band first, then approve and record the payment reference.',
  noun: 'withdrawal',
};

export const ADMIN_PAYOUT_CONFIG: AdminProcessConfig = {
  listEndpoint: '/admin/payouts',
  queryKey: ['admin', 'payouts'],
  heading: 'Payouts',
  subhead:
    'Review payouts companies have requested for themselves. Send the money, then approve and record the reference.',
  noun: 'payout',
};

export const ADMIN_LOAD_CONFIG: AdminProcessConfig = {
  listEndpoint: '/admin/loads',
  queryKey: ['admin', 'loads'],
  heading: 'Loads',
  subhead:
    'Review load requests — money the company says they sent us. Confirm receipt, then approve to credit their wallet.',
  noun: 'load',
};
