import { NextResponse, type NextRequest } from 'next/server';
import { fetchWithReconnect } from '@/lib/api-reconnect';
import { visitorIpHeader } from '@/lib/client-ip';

// Match the API's auth cookie names (apps/api/src/modules/auth/auth.constants.ts).
const ACCESS = 'txn_access';
const REFRESH = 'txn_refresh';
// Same internal API base the server-side fetch helper uses (api.server.ts).
const INTERNAL_BASE = process.env.API_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3001/v1';

/**
 * Silent session refresh on server-rendered navigations — so a returning user
 * isn't kicked to /login for being away a few minutes.
 *
 * The access cookie is short-lived (15m) and the refresh cookie is long (7d).
 * In-tab XHRs already refresh+retry on 401 (api.client.ts). But a FULL PAGE LOAD
 * after the access cookie lapsed used to hit getSession() → /auth/me → 401 →
 * redirect('/login'), even though the 7-day refresh token was still valid.
 *
 * When the access cookie is gone but a refresh cookie remains, we refresh ONCE
 * here, server-side, before the page renders: the rotated Set-Cookie(s) are both
 * (a) forwarded to the browser and (b) surfaced to THIS request so getSession()
 * sees a valid session and renders normally. The API's refresh has a rotation
 * grace window, so parallel navigations/prefetches refreshing at once are benign.
 * Best-effort: on any failure we pass through and let the page's auth check decide.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (req.cookies.has(ACCESS) || !req.cookies.has(REFRESH)) {
    return NextResponse.next();
  }

  let refreshRes: Response;
  try {
    // Waits out an API restart (api-reconnect.ts) — a POST, so only while the API
    // can't be reached at all: a refresh it may have seen is never repeated.
    refreshRes = await fetchWithReconnect(`${INTERNAL_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        cookie: req.headers.get('cookie') ?? '',
        // The refresh is made FOR this visitor: pass their address on, so it is
        // counted against their own refresh limit and recorded on their session
        // — not against one budget shared by everyone (see lib/client-ip.ts).
        ...visitorIpHeader(req.headers.get('x-forwarded-for')),
      },
    });
  } catch {
    return NextResponse.next();
  }
  if (!refreshRes.ok) return NextResponse.next();

  const setCookies = refreshRes.headers.getSetCookie();
  if (setCookies.length === 0) return NextResponse.next();

  // Merge the rotated cookies over the incoming ones so the downstream render
  // (getSession → /auth/me) sees the fresh access token in THIS request…
  const merged = new Map(req.cookies.getAll().map((c) => [c.name, c.value]));
  for (const sc of setCookies) {
    const pair = sc.split(';', 1)[0]?.trim();
    const eq = pair ? pair.indexOf('=') : -1;
    if (pair && eq > 0) merged.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('cookie', [...merged].map(([k, v]) => `${k}=${v}`).join('; '));

  // …and persist them to the browser on the way out.
  const res = NextResponse.next({ request: { headers: reqHeaders } });
  for (const sc of setCookies) res.headers.append('set-cookie', sc);
  return res;
}

export const config = {
  // Run on app pages only. Skip Next internals, static files (anything with a
  // dot), the auth pages (no point refreshing on /login), and the public /pay/*
  // payer landings — anonymous payers returning from Whish never have a session
  // to refresh, so they must not pay the refresh round-trip on that hot path.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|change-password|pay|.*\\..*).*)'],
};
