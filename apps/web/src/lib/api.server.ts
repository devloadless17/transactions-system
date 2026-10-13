import 'server-only';
import { cookies, headers } from 'next/headers';
import { ApiClientError, unwrapEnvelope, type ApiErrorBody } from './api';
import { visitorIpHeader } from './client-ip';

// Server-side (Node) base URL for the API. Use 127.0.0.1, NOT localhost:
// Node's fetch (undici) resolves `localhost` to IPv6 `::1` first on Windows,
// but the API listens on IPv4 only — so `localhost` yields "fetch failed".
// 127.0.0.1 forces IPv4. (The browser client uses NEXT_PUBLIC_API_BASE_URL,
// where localhost is fine because browsers fall back to IPv4.)
const INTERNAL_BASE = process.env.API_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3001/v1';

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  // Forward Set-Cookie headers from the API to the browser. Used by login.
  passSetCookieTo?: (header: string) => void;
}

/**
 * Server-side fetch to the API. Forwards the inbound user's cookies so
 * RLS / role checks work, and the visitor's IP so the API rate-limits, audits
 * and logs the call under the person it is made for — not under this server,
 * which would put every visitor's page loads into one shared budget (see
 * client-ip.ts). Throws ApiClientError on non-2xx.
 */
export async function apiServer<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...visitorIpHeader(incoming.get('x-forwarded-for')),
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
  return unwrapEnvelope<T>(await res.json());
}
