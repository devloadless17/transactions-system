// =================================================================
// Realtime (Socket.IO) contract — shared by the API gateway and the
// web client so both agree on event name, payload shape, and the set
// of "topics" a mutation can touch.
//
// The server emits a single `invalidate` event to the rooms that care
// (a company room and/or the admin room). The client maps each topic
// to the React Query keys it should invalidate, so data refreshes
// without a manual reload.
// =================================================================

/** The single Socket.IO event the server emits on any data change. */
export const REALTIME_EVENT = 'invalidate' as const;

/** Socket.IO namespace the realtime gateway is mounted on. */
export const REALTIME_NAMESPACE = '/realtime' as const;

/**
 * A domain area that changed. The client owns the topic → queryKey map.
 * Keep this list in sync with the emit sites on the server and the
 * invalidation map on the client.
 */
export const REALTIME_TOPICS = [
  'transactions',
  'wallets',
  'withdrawals',
  'payouts',
  'loads',
  'ledger',
  'analytics',
  'companies',
  'sources',
  'commissions',
  'api-keys',
  'team',
  'admin-users',
  'whish',
  'audit',
  'crm',
  'notifications',
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** Payload of the `invalidate` event. */
export interface RealtimeInvalidate {
  topics: RealtimeTopic[];
  /**
   * The company the change belongs to, when it is tenant-scoped. Admins
   * use this to refresh the right per-company views (e.g. a company detail
   * page); null for platform-wide changes (sources, admin users, …).
   */
  companyId: string | null;
}
