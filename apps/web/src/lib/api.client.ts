'use client';
import { toast } from '@/lib/toast';
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

/**
 * Expire every `csrf-token` cookie the browser holds — the host-only one AND each
 * parent-domain variant.
 *
 * A `csrf-token` minted under an OLD `COOKIE_DOMAIN` (a parent domain on a prior
 * deploy, or a prod cookie with Domain=parent that bled into a staging subdomain)
 * lingers as a DUPLICATE. The browser then sends two same-named cookies; the
 * server's parser and the client's reader can pick different ones, so the
 * double-submit `cookie === header` check fails — permanently, because the server
 * only ever sets the host-only cookie and so can't delete the parent-domain one.
 * That makes re-minting alone unable to recover (the user had to clear cookies by
 * hand). Clearing every domain variant here lets the freshly-minted host-only
 * token stand alone. Only invoked on a confirmed CSRF 403, so healthy sessions are
 * never touched.
 */
function expireCsrfCookieVariants(): void {
  if (typeof document === 'undefined') return;
  const expire = (domain?: string) => {
    const d = domain ? `; domain=${domain}` : '';
    document.cookie = `${CSRF_COOKIE_NAME}=; path=/; max-age=0; samesite=lax${d}`;
  };
  expire(); // host-only (no Domain attribute)
  const host = window.location.hostname;
  const parts = host.split('.');
  // Each registrable suffix (a.b.c, .a.b.c, b.c, .b.c, …), stopping before the
  // bare TLD so we never poke an unrelated public-suffix cookie.
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    expire(suffix);
    expire(`.${suffix}`);
  }
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
    // A stale CSRF token — e.g. right after CSRF_SECRET rotates or the token
    // format changes across a deploy — is rejected 403 by CsrfGuard BEFORE the
    // handler runs, so no side effect occurred and it is safe to re-mint the
    // token and replay the mutation once. Matched on the guard's exact message
    // so genuine authorization (role) 403s are never replayed.
    if (
      res.status === 403 &&
      !retried &&
      MUTATING.has(method) &&
      body?.error?.message === 'CSRF token missing or invalid'
    ) {
      // Drop any stale/duplicate csrf cookie (e.g. a parent-domain one shadowing
      // the host-only token) BEFORE re-minting, so the fresh token isn't shadowed
      // again — otherwise the retry resends the same bad cookie and 403s forever.
      expireCsrfCookieVariants();
      const r = await fetch(`${publicApiBase()}/auth/csrf`, { credentials: 'include' });
      if (r.ok) return requestWithAuthRetry<T>(path, opts, true);
    }
    throw new ApiClientError(res.status, body, `API ${method} ${path} failed`);
  }

  if (res.status === 204) return undefined as T;
  return unwrapEnvelope<T>(await res.json());
}
