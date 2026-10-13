/**
 * Which upstream hops are allowed to tell us the client's IP.
 *
 * `req.ip` feeds the per-IP rate limiter, the audit trail and the access log, so
 * getting it wrong is both a security and an availability problem:
 *
 *  - Believe too LITTLE and prod logs Cloudflare's edge IP as the client. Every
 *    user behind one edge IP then shares a single rate-limit bucket (they can
 *    429 each other), and an incident can't be traced to a caller — during the
 *    2026-09-09 export investigation the logs showed only `104.22.x` /
 *    `172.71.x`, so sessions had to be identified from login timestamps instead.
 *  - Believe too MUCH and a caller chooses its own IP: a fresh rate-limit bucket
 *    per request (the login and API-key limits never trip) and a forged address
 *    in the audit trail.
 *
 * ONE place decides who the visitor is: the edge proxy (Caddyfile → "WHO IS THE
 * VISITOR?"). It reads Cloudflare's `CF-Connecting-IP` — only from a Cloudflare
 * peer — or else takes the peer's own address, and hands this API exactly ONE
 * address in `X-Forwarded-For`, replacing whatever the request arrived with.
 *
 * Our own web server calls this API too (it server-renders pages), from the same
 * container network. It passes on that one address, which it received from the
 * proxy, so a page load is counted, audited and logged under the VISITOR — not
 * under the web server, where every visitor's page loads (and its own health
 * check) would share a single rate-limit budget. It forwards exactly one
 * well-formed IP or nothing at all (apps/web/src/lib/client-ip.ts).
 *
 * So the API trusts only the hop it is directly attached to: the container
 * network that proxy and that web server reach us over. It deliberately does NOT trust
 * Cloudflare's ranges itself. Walking an X-Forwarded-For chain past "trusted"
 * Cloudflare hops is unsafe — Cloudflare appends to a chain the caller started,
 * and a caller whose own address is inside Cloudflare's space (a Worker) would
 * get its forged left-most entry believed. With a single trusted hop the worst
 * case is fail-safe: if the proxy ever stopped rewriting the header, the address
 * we would resolve is the right-most one — the one Caddy itself appended, which
 * no caller controls — never a forged one.
 */

/**
 * Express `trust proxy` value. `loopback`/`linklocal`/`uniquelocal` cover the
 * container network Caddy and the web server talk to us over (and the local
 * health probe).
 *
 * `TRUSTED_PROXIES` overrides the whole list (comma-separated CIDRs/presets) as
 * an escape hatch if the topology changes and a code deploy is not an option.
 */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.TRUSTED_PROXIES?.trim();
  if (override) {
    const list = override
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return ['loopback', 'linklocal', 'uniquelocal'];
}
