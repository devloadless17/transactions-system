import 'server-only';
import { cookies } from 'next/headers';
import { ApiClientError, type ApiErrorBody } from './api';

const INTERNAL_BASE = process.env.API_INTERNAL_BASE_URL ?? 'http://localhost:3001/v1';

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  // Forward Set-Cookie headers from the API to the browser. Used by login.
  passSetCookieTo?: (header: string) => void;
}

/**
 * Server-side fetch to the API. Forwards the inbound user's cookies so
 * RLS / role checks work. Throws ApiClientError on non-2xx.
 */
export async function apiServer<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });

  if (opts.passSetCookieTo) {
    const sc = res.headers.get('set-cookie');
    if (sc) opts.passSetCookieTo(sc);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(res.status, body, `API ${method} ${path} failed`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
