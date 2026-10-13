/**
 * The visitor's IP, for the web server's OWN calls to the API.
 *
 * Pages are server-rendered: before a page is sent to the browser, this server
 * asks the API for the session and the first screen of data. Those requests
 * leave from the web container, so unless told otherwise the API sees ONE
 * caller — us — for every visitor. Its per-IP rate limit then puts everybody's
 * page loads (and this container's own health check) into a single budget, and
 * its audit trail and logs record the container's address instead of the person.
 *
 * So each server-side call passes on the visitor's address in X-Forwarded-For.
 * The API trusts the container network it is reached over (see
 * apps/api/src/common/http/trusted-proxies.ts), which is what lets it believe us.
 *
 * WHERE THE ADDRESS COMES FROM — and why it cannot be forged. It is read from
 * the X-Forwarded-For of the request this server received, and the only thing
 * that reaches this server is the edge proxy, which REPLACES that header with
 * the one address it resolved itself (Caddyfile → "WHO IS THE VISITOR?"):
 * nothing the visitor sent survives. This module still refuses anything that is
 * not exactly ONE well-formed IP address — a chain, a hostname, junk — and then
 * passes on nothing at all, so the API falls back to seeing this container.
 * A wrong address is never forwarded; the worst case is the old behaviour.
 */

// Dotted quad, each part 0–255, no leading zeros.
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// The longest textual IPv6 address (an IPv4-mapped one written in full).
const MAX_IP_LENGTH = 45;

/** `value` if it is exactly one valid IPv4 or IPv6 address, else null. */
export function singleIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ip = value.trim();
  if (ip.length === 0 || ip.length > MAX_IP_LENGTH) return null;
  if (IPV4.test(ip)) return ip;
  // IPv6 (incl. an IPv4-mapped tail). Hex digits, colons and dots only — which
  // by itself rules out a comma-separated chain, a port, brackets and a zone
  // id — then the platform's own URL parser judges the literal. (The URL API
  // exists in both the Node and the Edge runtime; `node:net` does not.)
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  try {
    new URL(`http://[${ip}]/`);
    return ip;
  } catch {
    return null;
  }
}

/**
 * The header to add to a server-side API call, given the X-Forwarded-For this
 * server received. Empty when there is no single valid address to pass on.
 */
export function visitorIpHeader(received: string | null | undefined): Record<string, string> {
  const ip = singleIp(received);
  return ip ? { 'x-forwarded-for': ip } : {};
}
