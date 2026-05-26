'use client';
import { toast } from 'sonner';
import { ApiClientError, PUBLIC_API_BASE, type ApiErrorBody } from './api';

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_FREE_PATHS = ['/auth/login', '/auth/refresh', '/auth/csrf'];

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
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body) headers['content-type'] = 'application/json';

  if (MUTATING.has(method)) {
    let csrf = readCookie(CSRF_COOKIE_NAME);
    if (!csrf) {
      // Fetch a CSRF token if we don't have one (first mutation after refresh).
      const r = await fetch(`${PUBLIC_API_BASE}/auth/csrf`, { credentials: 'include' });
      if (r.ok) csrf = readCookie(CSRF_COOKIE_NAME);
    }
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  }

  const res = await fetch(`${PUBLIC_API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (res.status === 401 && !AUTH_FREE_PATHS.some((p) => path.startsWith(p))) {
      notifySessionExpired();
    }
    throw new ApiClientError(res.status, body, `API ${method} ${path} failed`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
