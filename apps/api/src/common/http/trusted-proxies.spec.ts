import { describe, expect, it } from 'vitest';
import { BlockList, isIPv4 } from 'node:net';
import { CLOUDFLARE_CIDRS, trustedProxies } from './trusted-proxies';

/** The same membership test Express/proxy-addr performs, via Node's own BlockList. */
function edgeMatcher(): BlockList {
  const list = new BlockList();
  for (const cidr of CLOUDFLARE_CIDRS) {
    const [addr, bits] = cidr.split('/');
    list.addSubnet(addr!, Number(bits), isIPv4(addr!) ? 'ipv4' : 'ipv6');
  }
  return list;
}

describe('trustedProxies', () => {
  it('trusts the container network so Caddy can report the caller', () => {
    // Caddy reaches the API over the docker bridge (172.16/12 = uniquelocal);
    // the health probe comes from loopback. Without these the API would treat
    // its own reverse proxy as the client on every request.
    expect(trustedProxies({})).toEqual(
      expect.arrayContaining(['loopback', 'linklocal', 'uniquelocal']),
    );
  });

  it('covers the Cloudflare edge IPs actually seen in prod logs', () => {
    const cf = edgeMatcher();
    // Sampled from prod access logs on 2026-09-09 — these are the addresses the
    // old `trust proxy: 1` was mistaking for real clients.
    for (const ip of ['104.22.20.98', '172.71.154.237', '172.69.22.87', '104.22.40.134']) {
      expect(cf.check(ip), `${ip} must be recognised as a Cloudflare hop`).toBe(true);
    }
    expect(cf.check('2606:4700::1', 'ipv6')).toBe(true);
  });

  it('does not trust ordinary client addresses', () => {
    const cf = edgeMatcher();
    // If a real client address were ever inside the trusted set we would walk
    // straight past it and report whatever the caller put to its left.
    for (const ip of ['203.0.113.7', '8.8.8.8', '9.9.9.9', '187.77.177.127']) {
      expect(cf.check(ip), `${ip} must NOT be trusted`).toBe(false);
    }
    // 172.16/12 (docker) and 172.64/13 (Cloudflare) are adjacent but disjoint.
    expect(cf.check('172.18.0.5')).toBe(false);
  });

  it('honours a TRUSTED_PROXIES override, ignoring blank entries', () => {
    expect(trustedProxies({ TRUSTED_PROXIES: '10.0.0.0/8, , loopback ' })).toEqual([
      '10.0.0.0/8',
      'loopback',
    ]);
  });

  it('falls back to the built-in list when the override is empty or absent', () => {
    // A malformed/blank env var must not silently leave us trusting nothing —
    // that would make Caddy itself the "client" for every request.
    for (const env of [{}, { TRUSTED_PROXIES: '' }, { TRUSTED_PROXIES: '   ' }]) {
      expect(trustedProxies(env)).toContain('uniquelocal');
      expect(trustedProxies(env)).toContain('104.16.0.0/13');
    }
  });
});
