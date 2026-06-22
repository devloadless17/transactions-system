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
import { publicApiBase } from './api';
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
    // The unified activity feed includes deposits — refresh it too.
    ['admin', 'activity'],
    ['company', 'activity'],
    ...(c ? [['admin', 'company', c, 'transactions']] : []),
  ],
  wallets: (c) => [['company', 'wallets'], ...(c ? [['admin', 'company', c, 'wallets']] : [])],
  withdrawals: () => [
    ['admin', 'withdrawals'],
    ['company', 'withdrawals'],
    ['admin', 'activity'],
    ['company', 'activity'],
    // Sidebar PENDING-request badge.
    ['company', 'operations', 'counts'],
    ['admin', 'operations', 'counts'],
  ],
  payouts: () => [
    ['admin', 'payouts'],
    ['company', 'payouts'],
    ['admin', 'activity'],
    ['company', 'activity'],
    ['company', 'operations', 'counts'],
    ['admin', 'operations', 'counts'],
  ],
  loads: () => [
    ['admin', 'loads'],
    ['company', 'loads'],
    ['admin', 'activity'],
    ['company', 'activity'],
    ['company', 'operations', 'counts'],
    ['admin', 'operations', 'counts'],
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
  crm: () => [['company', 'crm']],
  // In-app notifications (the topbar bell). One key for both scopes.
  notifications: () => [['notifications']],
};

/** Origin of the API (strip the `/v1` path) so we can reach the socket server. */
function socketOrigin(): string | null {
  try {
    return new URL(publicApiBase()).origin;
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

    // Cleared on unmount so a refresh-then-reconnect already in flight can't
    // reopen this socket after the effect has torn it down (fast unmount/remount).
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Coalesces the connect-time catch-up: a connect → forced-disconnect →
    // reconnect bounce (token rotation) or a wake/restore reconnect cycle can fire
    // 'connect' several times in quick succession. A short trailing debounce
    // collapses that burst into a single refetch instead of one storm per bounce.
    let catchup: ReturnType<typeof setTimeout> | undefined;
    // Fires a few seconds after a connect; resets the auth-reconnect backoff only
    // if the connection actually SURVIVED that long (cleared on disconnect).
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    // Bounded backoff for forced (auth) disconnects — see the disconnect handler.
    let authReconnects = 0;
    const MAX_AUTH_RECONNECTS = 5;

    socket.on('connect', () => {
      // The socket only delivers events received WHILE connected. Anything that
      // happened before/while connecting — a transaction landing in the
      // sub-second after a page load or reload, a dev hot-reload, a network blip
      // or token refresh — would otherwise be missed forever. So on EVERY
      // connect (including the first) refetch all active queries to catch up.
      // The page's initial data was just loaded, so this costs at most one
      // redundant refetch; guaranteeing "never miss a live update" is worth it
      // and is what keeps the dashboard correct even right after a refresh.
      // Reset the auth-reconnect backoff only once the connection has SURVIVED a
      // few seconds. A connect immediately followed by a forced 'io server
      // disconnect' (expired cookie) must not reset it, or we'd hot-loop
      // reconnect+refresh every ~1.5s instead of backing off.
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        authReconnects = 0;
      }, 3000);
      // Refetch only ACTIVE (mounted-observer) queries — inactive/other-app keys
      // are no-ops anyway, and this avoids waking background caches. Debounced so
      // a reconnect bounce settles into one catch-up rather than a refetch storm.
      if (catchup) clearTimeout(catchup);
      catchup = setTimeout(() => {
        void qc.invalidateQueries({ refetchType: 'active' });
      }, 250);
    });

    socket.on('disconnect', (reason) => {
      // socket.io auto-reconnects on transport drops, but NOT when the server
      // forcibly disconnects us — our gateway does this when the handshake cookie
      // is missing/expired (the access token is only 15 min). Rotate the token via
      // the refresh cookie, THEN reconnect — but ONLY if the refresh actually
      // SUCCEEDED. If it didn't (refresh token also expired/revoked, or backend
      // down), reconnecting would re-send the same dead cookie, the gateway would
      // drop us again, and this timer would re-arm every 1.5s forever. So stop
      // after MAX attempts and back off exponentially; the app's session-expiry
      // flow (triggered by the next authenticated request) takes over from there.
      // The connection didn't survive — cancel the pending "stable" reset so the
      // backoff keeps growing across repeated auth failures.
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = undefined;
      }
      if (reason !== 'io server disconnect') return;
      if (authReconnects >= MAX_AUTH_RECONNECTS) return;
      const delay = 1500 * 2 ** authReconnects; // 1.5s → 3s → 6s → 12s → 24s
      authReconnects += 1;
      retry = setTimeout(() => {
        void refreshSession().then((ok) => {
          if (active && ok) socket.connect();
          // refresh failed → leave the socket closed; do not re-send a dead cookie.
        });
      }, delay);
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
      active = false;
      if (retry) clearTimeout(retry);
      if (stableTimer) clearTimeout(stableTimer);
      if (catchup) clearTimeout(catchup);
      socket.off();
      socket.disconnect();
    };
  }, [qc]);

  return null;
}
