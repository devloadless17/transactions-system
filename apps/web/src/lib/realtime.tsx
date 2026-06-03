'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import {
  REALTIME_EVENT,
  REALTIME_NAMESPACE,
  type RealtimeInvalidate,
  type RealtimeTopic,
} from '@app/shared';
import { PUBLIC_API_BASE } from './api';
import { refreshSession } from './api.client';

/**
 * Maps a changed topic to the React Query keys that should be refreshed.
 * Invalidation is prefix-based (TanStack default), so `['admin','company',id]`
 * also refreshes that company's wallets/transactions/audit sub-queries.
 *
 * Keys for the "other" app (admin keys on a company session and vice-versa)
 * are harmless: invalidating a key with no mounted observer is a no-op.
 */
type KeysFor = (companyId: string | null) => string[][];

const TOPIC_KEYS: Record<RealtimeTopic, KeysFor> = {
  transactions: (c) => [
    ['admin', 'transactions'],
    ['company', 'transactions'],
    ...(c ? [['admin', 'company', c, 'transactions']] : []),
  ],
  wallets: (c) => [['company', 'wallets'], ...(c ? [['admin', 'company', c, 'wallets']] : [])],
  withdrawals: () => [
    ['admin', 'withdrawals'],
    ['company', 'withdrawals'],
  ],
  payouts: () => [
    ['admin', 'payouts'],
    ['company', 'payouts'],
  ],
  loads: () => [
    ['admin', 'loads'],
    ['company', 'loads'],
  ],
  ledger: () => [['company', 'ledger']],
  analytics: (c) => [
    ['admin', 'analytics'],
    ['company', 'analytics'],
    ...(c ? [['admin', 'company', c, 'overview']] : []),
  ],
  companies: (c) => [['admin', 'companies'], ...(c ? [['admin', 'company', c]] : [])],
  sources: () => [
    ['admin', 'sources'],
    ['sources', 'all'],
  ],
  commissions: () => [['admin', 'commission-rules']],
  'api-keys': () => [['company', 'api-keys']],
  team: (c) => [['company', 'team'], ...(c ? [['admin', 'company', c, 'users']] : [])],
  'admin-users': () => [['admin', 'users']],
  whish: () => [
    ['company', 'whish'],
    ['admin', 'whish'],
  ],
  audit: (c) => [['admin', 'audit-logs'], ...(c ? [['admin', 'company', c, 'audit']] : [])],
};

/** Origin of the API (strip the `/v1` path) so we can reach the socket server. */
function socketOrigin(): string | null {
  try {
    return new URL(PUBLIC_API_BASE).origin;
  } catch {
    return null;
  }
}

/**
 * Opens an authenticated Socket.IO connection (auth via the same cookie the
 * HTTP API uses) and turns server `invalidate` hints into React Query
 * invalidations, so dashboards update live without a manual refresh.
 *
 * Render once inside an authenticated layout, under the QueryClientProvider.
 */
export function RealtimeBridge() {
  const qc = useQueryClient();

  useEffect(() => {
    const origin = socketOrigin();
    if (!origin) return;

    // Default transport order (polling → upgrade to websocket): the polling
    // handshake reliably carries the auth cookie cross-origin, and the upgrade
    // gives us a live socket once established. `withCredentials` sends the
    // `txn_access` cookie on the handshake; reconnection is on by default.
    const socket = io(origin + REALTIME_NAMESPACE, { withCredentials: true });

    socket.on('connect', () => {
      // The socket only delivers events received WHILE connected. Anything that
      // happened before/while connecting — a transaction landing in the
      // sub-second after a page load or reload, a dev hot-reload, a network blip
      // or token refresh — would otherwise be missed forever. So on EVERY
      // connect (including the first) refetch all active queries to catch up.
      // The page's initial data was just loaded, so this costs at most one
      // redundant refetch; guaranteeing "never miss a live update" is worth it
      // and is what keeps the dashboard correct even right after a refresh.
      void qc.invalidateQueries();
    });

    let retry: ReturnType<typeof setTimeout> | undefined;
    socket.on('disconnect', (reason) => {
      // socket.io auto-reconnects on transport drops, but NOT when the server
      // forcibly disconnects us — our gateway does this when the handshake
      // cookie is missing/expired (the access token is only 15 min). Blindly
      // reconnecting would just re-send the same dead cookie forever, so first
      // rotate the access token via the refresh cookie, THEN reconnect with it.
      // On success the `connect` handler above catches up anything missed.
      if (reason === 'io server disconnect') {
        retry = setTimeout(() => {
          void refreshSession().finally(() => socket.connect());
        }, 1500);
      }
    });

    socket.on(REALTIME_EVENT, (payload: RealtimeInvalidate) => {
      if (!payload?.topics?.length) return;
      for (const topic of payload.topics) {
        const keysFor = TOPIC_KEYS[topic as RealtimeTopic];
        if (!keysFor) continue;
        for (const queryKey of keysFor(payload.companyId)) {
          void qc.invalidateQueries({ queryKey });
        }
      }
    });

    return () => {
      if (retry) clearTimeout(retry);
      socket.off();
      socket.disconnect();
    };
  }, [qc]);

  return null;
}
