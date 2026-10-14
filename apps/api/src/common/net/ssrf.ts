import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ValidationError } from '../errors/domain.error';

/**
 * SSRF protection for server-initiated HTTP to URLs that an untrusted tenant
 * controls (the outbound Whish webhook + CRM delivery). We refuse any URL that
 * is not https or whose host resolves to a private/loopback/link-local/reserved
 * address — most importantly the cloud metadata endpoint (169.254.169.254).
 *
 * `assertSafeWebhookUrl` is called when a company SETS its webhook URL (fail fast
 * with a 400). For actual delivery use `safeFetch`, which validates AND pins the
 * connection to the exact IP it validated — so the validate-then-connect steps
 * can't resolve to different hosts (DNS rebinding). SNI/Host stay on the original
 * hostname, so TLS still verifies normally.
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, maskBits: number): boolean => {
    const b = ipv4ToInt(base)!;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. cloud metadata)
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

/** Expand a (syntactically valid) IPv6 literal to its 16 bytes, or null. */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!; // strip any zone id
  // An embedded dotted-quad tail (e.g. ::ffff:127.0.0.1) → rewrite as two hextets
  // so the rest of the parser only ever deals with hex groups.
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null; // at most one '::'
  const toBytes = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const v = parseInt(g, 16);
      out.push((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  };
  const head = toBytes(halves[0]!);
  const tail = halves.length === 2 ? toBytes(halves[1]!) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const fill = 16 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 16 ? head : null;
}

function isPrivateIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → treat as unsafe
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  // Addresses that embed an IPv4 destination in the low 32 bits must be classified
  // by THAT IPv4 regardless of textual form, or `::ffff:7f00:1` (= 127.0.0.1) and
  // `64:ff9b::a9fe:a9fe` (= 169.254.169.254 metadata) sneak through as "public".
  const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff; // ::ffff:0:0/96
  const isCompat = b.slice(0, 12).every((x) => x === 0); // ::/96 deprecated IPv4-compatible
  const isNat64 =
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0); // 64:ff9b::/96
  if (isMapped || isCompat || isNat64) return isPrivateIPv4(b.slice(12, 16).join('.'));
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if ((b[0] & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (b[0] === 0xff) return true; // multicast ff00::/8
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a recognizable IP literal → unsafe
}

/** The validated IP(s) for a webhook host — used to pin the outbound connection. */
export interface ResolvedHost {
  addresses: Array<{ address: string; family: number }>;
}

export async function assertSafeWebhookUrl(raw: string): Promise<ResolvedHost> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new ValidationError('Webhook URL must use https');
  }
  if (url.username || url.password) {
    throw new ValidationError('Webhook URL must not contain credentials');
  }
  const host = url.hostname;
  // Literal IP host: check directly. Hostname: resolve every record and reject
  // if any points at an internal address.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new ValidationError('Webhook URL resolves to a disallowed (private/internal) address');
    }
    return { addresses: [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new ValidationError('Webhook host could not be resolved');
  }
  if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
    throw new ValidationError('Webhook URL resolves to a disallowed (private/internal) address');
  }
  return { addresses: records.map((r) => ({ address: r.address, family: r.family })) };
}

type SafeFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

// Connections to a webhook host are kept open and reused (keep-alive) instead
// of a new TCP + TLS connection for every event — at thousands of events a
// minute, a handshake per event is most of the work, on our side and on the
// receiver's. An agent is keyed by the host AND the exact addresses just
// validated for it, and it can only dial those addresses: a reused connection
// reaches nothing the check did not pass, and a DNS change (to anything) makes
// a new key, so a fresh agent pinned to the newly validated addresses.
const pinnedAgents = new Map<string, { agent: Agent; usedAt: number }>();
const AGENT_IDLE_MS = 2 * 60_000;
const MAX_AGENTS = 500;

/** The pooled agent for `host` pinned to `addresses` (exported for tests). */
export function pinnedAgentFor(host: string, addresses: ResolvedHost['addresses']): Agent {
  const key = `${host}|${addresses
    .map((a) => `${a.family}/${a.address}`)
    .sort()
    .join(',')}`;
  const now = Date.now();
  const hit = pinnedAgents.get(key);
  if (hit) {
    hit.usedAt = now;
    return hit.agent;
  }
  // Retire idle agents, and the oldest beyond the cap, before adding one.
  for (const [k, v] of pinnedAgents) {
    if (now - v.usedAt > AGENT_IDLE_MS || pinnedAgents.size >= MAX_AGENTS) {
      pinnedAgents.delete(k);
      void v.agent.close().catch(() => {});
    }
  }
  const agent = new Agent({
    keepAliveTimeout: 30_000,
    connect: {
      // undici calls this with { all: true } and expects an address array; we
      // ignore the (re-)resolution and return only the pre-validated IP(s).
      lookup(_hostname, options, callback) {
        if ((options as { all?: boolean })?.all) {
          callback(null, addresses as unknown as Parameters<typeof callback>[1]);
        } else {
          callback(null, addresses[0]!.address as never, addresses[0]!.family);
        }
      },
    },
  });
  pinnedAgents.set(key, { agent, usedAt: now });
  return agent;
}

/**
 * Validate `url` against the SSRF policy and fetch it with the connection PINNED
 * to the exact IP(s) we just validated. This closes the validate-then-connect
 * DNS-rebinding window: the socket can only dial an address that passed the
 * check. The Host header and TLS SNI stay on the original hostname, so cert
 * verification is unaffected. Throws ValidationError for a disallowed URL.
 *
 * Connections are reused across calls (see pinnedAgentFor), so read or cancel
 * the response body: an unread body keeps its connection from being reused.
 */
export async function safeFetch(url: string, init: SafeFetchInit = {}) {
  const { addresses } = await assertSafeWebhookUrl(url);
  return undiciFetch(url, {
    ...init,
    dispatcher: pinnedAgentFor(new URL(url).hostname, addresses),
  });
}
