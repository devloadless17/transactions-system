import { describe, expect, it } from 'vitest';
import { singleIp, visitorIpHeader } from './client-ip';

/**
 * What the web server passes to the API as "the visitor" decides whose
 * rate-limit budget a page load spends and whose address the audit trail
 * records. It must be exactly one real IP address — or nothing.
 */
describe('singleIp', () => {
  it('accepts one IPv4 address', () => {
    for (const ip of ['203.0.113.7', '77.246.68.222', '0.0.0.0', '255.255.255.255', '127.0.0.1']) {
      expect(singleIp(ip)).toBe(ip);
    }
    expect(singleIp('  203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('accepts one IPv6 address, including the forms a proxy really sends', () => {
    for (const ip of [
      '2a0b:3f80:17:1be5:c166:38e3:5c96:3dd6', // a real visitor seen in production
      '2a06:98c0:3600::103', //                   Cloudflare's shared Worker address
      '::1', //                                   the container's own health check
      '::ffff:127.0.0.1', //                      IPv4-mapped loopback
      '2001:db8::',
      '2001:DB8::ABCD',
    ]) {
      expect(singleIp(ip), ip).toBe(ip);
    }
  });

  it('refuses a CHAIN — the caller-seeded form that must never be believed', () => {
    for (const chain of [
      '6.6.6.6, 203.0.113.7',
      '6.6.6.6,203.0.113.7',
      '203.0.113.7, 104.22.40.137',
      '2001:db8::1, 203.0.113.7',
      '203.0.113.7 6.6.6.6',
    ]) {
      expect(singleIp(chain), chain).toBeNull();
    }
  });

  it('refuses anything that is not an IP address', () => {
    for (const junk of [
      '',
      '   ',
      'unknown',
      'localhost',
      'evil.example.com',
      '203.0.113',
      '203.0.113.7.1',
      '256.1.1.1',
      '01.2.3.4', //            leading zero (octal in some parsers)
      '1.2.3.4:8080', //        a port
      '[2001:db8::1]', //       brackets
      '[2001:db8::1]:443',
      'fe80::1%eth0', //        a zone id
      '2001:db8:::1', //        malformed
      '1:2:3:4:5:6:7:8:9', //   too many groups
      'gggg::1',
      '::ffff:999.1.1.1',
      '203.0.113.7\r\nX-Injected: 1',
      '2001:db8::1'.padEnd(60, '0'),
    ]) {
      expect(singleIp(junk), JSON.stringify(junk)).toBeNull();
    }
    expect(singleIp(null)).toBeNull();
    expect(singleIp(undefined)).toBeNull();
  });
});

describe('visitorIpHeader', () => {
  it('passes the one address on as X-Forwarded-For', () => {
    expect(visitorIpHeader('203.0.113.7')).toEqual({ 'x-forwarded-for': '203.0.113.7' });
    expect(visitorIpHeader('2a06:98c0:3600::103')).toEqual({
      'x-forwarded-for': '2a06:98c0:3600::103',
    });
  });

  it('adds NOTHING when there is no single valid address — the API then sees this server', () => {
    expect(visitorIpHeader(null)).toEqual({});
    expect(visitorIpHeader('')).toEqual({});
    expect(visitorIpHeader('6.6.6.6, 203.0.113.7')).toEqual({});
    expect(visitorIpHeader('not-an-ip')).toEqual({});
  });
});
