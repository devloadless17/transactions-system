'use client';
import { toast } from 'sonner';
import { ApiClientError, publicApiBase, unwrapEnvelope, type ApiErrorBody } from './api';

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_FREE_PATHS = ['/auth/login', '/auth/refresh', '/auth/csrf'];

// Shared across tabs so a proactive keep-alive in one tab suppresses the others
// (the refresh endpoint rotates+revokes the refresh token, so two tabs
// refreshing at once would revoke each other).
const LAST_REFRESH_KEY = 'txn_last_refresh';

/** When the access cookie was last rotated (epoch ms), shared across tabs. */
export function lastRefreshAt(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = window.localStorage.getItem(LAST_REFRESH_KEY);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

export function markRefreshed(at = Date.now()): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_REFRESH_KEY, String(at));
  } catch {
    // ignore storage failures (private mode, quota) — refresh still works.
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Rotate the short-lived access cookie via the refresh token. `/auth/refresh`
 * is public (no CSRF needed) and sets fresh cookies on the response. De-duped
 * within a tab so concurrent callers (an HTTP 401, the socket, the keep-alive)
 * share a single network round-trip. Never throws — resolves false on failure.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${publicApiBase()}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) markRefreshed();
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

let sessionExpiredToastShown = false;
function notifySessionExpired() {
  if (sessionExpiredToastShown) return;
  sessionExpiredToastShown = true;
  toast.error('Session expired — please sign in again');
  // Bounce to login after a beat. window-only.
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      window.location.href = '/login';
    }, 600);
  }
}

interface ClientRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export async function apiFetch<T>(path: string, opts: ClientRequestOpts = {}): Promise<T> {
  return requestWithAuthRetry<T>(path, opts, false);
}

async function requestWithAuthRetry<T>(
  path: string,
  opts: ClientRequestOpts,
  retried: boolean,
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body) headers['content-type'] = 'application/json';

  if (MUTATING.has(method)) {
    let csrf = readCookie(CSRF_COOKIE_NAME);
    if (!csrf) {
      // Fetch a CSRF token if we don't have one (first mutation after refresh).
      const r = await fetch(`${publicApiBase()}/auth/csrf`, { credentials: 'include' });
      if (r.ok) csrf = readCookie(CSRF_COOKIE_NAME);
    }
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  }

  const res = await fetch(`${publicApiBase()}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    if (res.status === 401 && !AUTH_FREE_PATHS.some((p) => path.startsWith(p))) {
      // The 15-min access cookie likely lapsed. Rotate it once with the refresh
      // token and replay the request before giving up — so an idle-then-active
      // session renews transparently instead of bouncing to login.
      if (!retried && (await refreshSession())) {
        return requestWithAuthRetry<T>(path, opts, true);
      }
      notifySessionExpired();
    }
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(res.status, body, `API ${method} ${path} failed`);
  }

  if (res.status === 204) return undefined as T;
  return unwrapEnvelope<T>(await res.json());
}
