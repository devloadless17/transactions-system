/**
 * Ride out an API restart on the web server's OWN calls to the API.
 *
 * The browser reaches the API through Caddy, which holds a request for up to 15s
 * while a deploy swaps the api container (`lb_try_duration` in the Caddyfile).
 * The web server does not: it calls the API directly on the container network
 * (API_INTERNAL_BASE_URL → api:3001). A page load that landed in the swap got
 * "fetch failed", getSession() threw, and the user saw "Something went wrong"
 * until they refreshed — a rare, deploy-shaped failure nobody could reproduce.
 *
 * This gives that hop the same window and the same rule Caddy uses: try again
 * only when the request was never delivered (and so cannot have been acted on).
 * Anything the API answered — a 401, a 429, a 5xx — is returned as-is.
 *
 * What "never delivered" means, measured against Node's fetch (undici), which
 * reports the socket error as `TypeError('fetch failed', { cause: { code } })`:
 *   - no connection could be made — the container is gone (ENOTFOUND/EAI_AGAIN
 *     while Docker's DNS has no `api`), not listening yet (ECONNREFUSED), or
 *     unreachable. Safe for ANY method: nothing was sent.
 *   - the connection dropped under the request — a keep-alive socket to the old
 *     container (UND_ERR_SOCKET "other side closed", ECONNRESET, EPIPE). The API
 *     may have seen it, so this is retried for GET only, which is read-only.
 * A failure with any other shape is thrown at once: when in doubt, don't repeat.
 */

/** Same window Caddy gives a browser request (Caddyfile: lb_try_duration). */
export const API_RECONNECT_WINDOW_MS = 15_000;
/** Same pace as Caddy (Caddyfile: lb_try_interval). */
export const API_RECONNECT_INTERVAL_MS = 250;

// No connection was established: nothing reached the API.
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// Connected, then lost: the API may have received the request.
const CONNECTION_LOST = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

function errorCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } } | null | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

/** True when `err` is a fetch failure that is safe to repeat for `method`. */
export function isRetryableFetchFailure(err: unknown, method: string): boolean {
  const code = errorCode(err);
  if (code === null) return false;
  if (NOT_CONNECTED.has(code)) return true;
  return method.toUpperCase() === 'GET' && CONNECTION_LOST.has(code);
}

export interface ReconnectDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  windowMs?: number;
  intervalMs?: number;
}

/** `fetch`, retried while the API cannot be reached (see the module comment). */
export async function fetchWithReconnect(
  url: string,
  init: RequestInit,
  deps: ReconnectDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? API_RECONNECT_INTERVAL_MS;
  const deadline = now() + (deps.windowMs ?? API_RECONNECT_WINDOW_MS);
  const method = init.method ?? 'GET';
  // A retry must really go to the network. Next memoizes a server render's GETs
  // by URL (server/lib/dedupe-fetch.js) and hands every repeat the first call's
  // promise — a rejected one included — so a plain retry just re-reads the
  // original "fetch failed" without a byte sent. A `signal` is Next's opt-out.
  const retryInit: RequestInit = { ...init, signal: init.signal ?? new AbortController().signal };

  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch(url, attempt === 0 ? init : retryInit);
    } catch (err) {
      if (!isRetryableFetchFailure(err, method) || now() + intervalMs > deadline) throw err;
      await sleep(intervalMs);
    }
  }
}
