// Per-process configs for the admin Withdraw / Payout / Load review pages.
import type { AdminProcessConfig } from './withdrawals-view';

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
