import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ValidationError } from '../errors/domain.error';

/**
 * SSRF protection for server-initiated HTTP to URLs that an untrusted tenant
 * controls (currently the outbound Whish webhook). We refuse any URL that is
 * not https or whose host resolves to a private/loopback/link-local/reserved
 * address — most importantly the cloud metadata endpoint (169.254.169.254).
 *
 * `assertSafeWebhookUrl` is called both when a company SETS its webhook URL
 * (fail fast with a 400) and again immediately before each delivery, so a name
 * that is later re-pointed at an internal address (DNS rebinding) is caught at
 * send time too.
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

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]!; // strip any zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  if (addr.startsWith('ff')) return true; // multicast ff00::/8
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not a recognizable IP literal → unsafe
}

export async function assertSafeWebhookUrl(raw: string): Promise<void> {
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
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new ValidationError('Webhook host could not be resolved');
  }
  if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
    throw new ValidationError('Webhook URL resolves to a disallowed (private/internal) address');
  }
}
