/**
 * Which upstream hops are allowed to tell us the client's IP.
 *
 * `req.ip` feeds the per-IP rate limiter, the audit trail and the access log, so
 * getting it wrong is both a security and an availability problem:
 *
 *  - Too FEW trusted hops (the old `trust proxy: 1`) and prod logs Cloudflare's
 *    edge IP as the client. Every user behind one edge IP then shares a single
 *    rate-limit bucket (they can 429 each other), and an incident can't be
 *    traced to a caller — during the 2026-09-09 export investigation the logs
 *    showed only `104.22.x` / `172.71.x`, so sessions had to be identified from
 *    login timestamps instead.
 *  - Too MANY (a blunt `trust proxy: 2`) and any hop count shorter than the
 *    assumed one becomes spoofable. Staging is exactly that case: it resolves
 *    straight to Caddy with NO Cloudflare in front, so with `2` a caller could
 *    forge `X-Forwarded-For` and both poison the audit trail and dodge the
 *    limiter.
 *
 * Trusting by ADDRESS rather than by count is correct for both topologies at
 * once: we walk right-to-left and stop at the first hop we did not put there.
 * Prod (client → Cloudflare → Caddy → API) and staging (client → Caddy → API)
 * both resolve to the real client, and a forged header never survives because
 * it always sits to the LEFT of a hop we trust.
 *
 * Fail-safe by construction: if Cloudflare adds a range we don't list, that hop
 * is simply untrusted and we log ITS address — today's behaviour, never a
 * spoofed one.
 */

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
// These change rarely; refresh them if CF announces new space. Verified against
// the edge IPs seen in prod logs (104.22.x, 172.69.x, 172.71.x).
export const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

/**
 * Express `trust proxy` value. `loopback`/`linklocal`/`uniquelocal` cover the
 * container network Caddy talks to us over (and the local health probe); the
 * Cloudflare ranges cover the edge in front of the prod domain only.
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
  return ['loopback', 'linklocal', 'uniquelocal', ...CLOUDFLARE_CIDRS];
}
