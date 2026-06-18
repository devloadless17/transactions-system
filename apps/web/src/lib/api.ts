/**
 * Shared types & a tiny error class. Safe to import from either server or
 * client components — actual HTTP clients live in api.server.ts and
 * api.client.ts respectively, so that server-only logic (cookies, headers,
 * env-only URLs) doesn't leak into the client bundle.
 */

/**
 * Browser-facing API base URL.
 *
 * Web and API are SAME-ORIGIN in every deployed environment (Caddy serves
 * `/v1/*` on the same domain as the web app), so the browser just calls its own
 * origin + `/v1`. Computing this at RUNTIME — instead of baking an absolute URL
 * into the bundle — makes the built web image domain-agnostic: the exact same
 * prod image serves a staging instance on a different subdomain with no rebuild.
 *
 * Precedence:
 *   1. An explicit build-time `NEXT_PUBLIC_API_BASE_URL` wins. Local dev runs the
 *      web (:3000) and API (:3001) on DIFFERENT origins, so `.env` sets this to
 *      `http://localhost:3001/v1` and same-origin must NOT kick in.
 *   2. Otherwise (prod/staging images are built with the var empty) → same-origin.
 *   3. Server-side/no-window fallback (SSR first paint of docs snippets only;
 *      real browser calls never hit this) → localhost default.
 */
export function publicApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    // In EVERY deployed environment the web app and API share an origin, so the
    // page's own origin is authoritative — we ignore any baked URL here. This is
    // what makes one image portable across prod/staging, and it also means a
    // mis-baked build value can never make prod call the wrong API.
    const localPage =
      origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    if (!localPage) return `${origin}/v1`;
    // Local dev serves the web (:3000) and API (:3001) on DIFFERENT origins.
    // `next dev` does NOT load the monorepo-root .env, so NEXT_PUBLIC_API_BASE_URL
    // is usually empty here — fall back to the API's dev port, NOT same-origin
    // (same-origin would POST to the Next server on :3000 and 404).
    return fromEnv || 'http://localhost:3001/v1';
  }
  // Server-side (SSR first paint of doc snippets only; real browser calls never
  // reach this) — fall back to the build-time value, else localhost.
  return fromEnv || 'http://localhost:3001/v1';
}

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/**
 * The API wraps every successful JSON response in `{ success, statusCode, data }`
 * (see the server's ResponseEnvelopeInterceptor). Callers only care about the
 * payload, so unwrap `data` here. A handful of endpoints are intentionally
 * outside the envelope (health, CSV, 204s) — for those (or any already-unwrapped
 * body) we pass the body through untouched.
 */
export function unwrapEnvelope<T>(body: unknown): T {
  if (body !== null && typeof body === 'object' && 'success' in body && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(body?.error?.message ?? fallbackMessage);
    this.status = status;
    this.code = body?.error?.code ?? `HTTP_${status}`;
    this.details = body?.error?.details;
  }
}
