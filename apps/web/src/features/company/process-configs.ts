// Per-process configs for the company-side Withdraw / Payout / Load
// pages. The three pages share `WithdrawalsView` and differ only in
// which backend endpoint they hit and how their copy reads.
import type { ProcessConfig } from './withdrawals-view';
import type { ListPrefetch } from '@/lib/prefetch';

/**
 * Descriptor for WithdrawalsView's initial list query — page 1, pageSize 50, no
 * filters. MUST stay in sync with withdrawals-view.tsx
 * (`flowFilterParams(EMPTY_FLOW_FILTERS, { pageSize: '50', page: '1' })` → key
 * `[...queryKey, 'list', '<qs>']`). Lives in this non-'use client' module so the
 * server page can import it (the client param builder can't run in RSC).
 */
export function defaultListPrefetch(config: ProcessConfig): ListPrefetch {
  const qs = 'pageSize=50&page=1';
  return { queryKey: [...config.queryKey, 'list', qs], path: `${config.endpoint}?${qs}` };
}

export const WITHDRAWAL_CONFIG: ProcessConfig = {
  endpoint: '/company/withdrawals',
  queryKey: ['company', 'withdrawals'],
  heading: 'Withdrawals',
  subhead:
    'Pay an external third party from your wallet. Funds move to reserved until an operator sends the money and approves.',
  newButton: 'New withdrawal',
  emptyState: 'No withdrawals yet.',
  dialogTitle: 'Request a withdrawal',
  dialogDescription:
    'Pay an external third party from your wallet. The amount moves to reserved while the operator executes the payment.',
  noun: 'withdrawal',
};

export const PAYOUT_CONFIG: ProcessConfig = {
  endpoint: '/company/payouts',
  queryKey: ['company', 'payouts'],
  heading: 'Payouts',
  subhead:
    'Withdraw funds from your wallet to yourself. Funds move to reserved until an operator executes the payout.',
  newButton: 'New payout',
  emptyState: 'No payouts yet.',
  dialogTitle: 'Request a payout',
  dialogDescription:
    'Withdraw money from your wallet to yourself. The amount moves to reserved until the operator approves and sends it.',
  noun: 'payout',
};

export const LOAD_CONFIG: ProcessConfig = {
  endpoint: '/company/loads',
  queryKey: ['company', 'loads'],
  heading: 'Loads',
  subhead:
    'Money you sent us in real life. The operator credits your wallet once they confirm receipt.',
  newButton: 'New load',
  emptyState: 'No loads yet.',
  dialogTitle: 'Request a load',
  dialogDescription:
    'You sent us money in real life — record it here. The operator credits your wallet once they confirm receipt.',
  noun: 'load',
};
