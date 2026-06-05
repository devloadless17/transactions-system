/**
 * Shared types & a tiny error class. Safe to import from either server or
 * client components — actual HTTP clients live in api.server.ts and
 * api.client.ts respectively, so that server-only logic (cookies, headers,
 * env-only URLs) doesn't leak into the client bundle.
 */

export const PUBLIC_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/v1';

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
