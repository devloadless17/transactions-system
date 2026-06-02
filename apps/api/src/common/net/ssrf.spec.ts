import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, isPrivateAddress } from './ssrf';

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and metadata IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10' /* TEST-NET-3 is /24, not blocked */]) {
      // 203.0.113.0/24 is documentation space but not in our private set; treat as public.
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('treats non-IP strings as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertSafeWebhookUrl', () => {
  it('rejects non-https schemes', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook')).rejects.toThrow(/https/i);
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(assertSafeWebhookUrl('https://user:pass@example.com/hook')).rejects.toThrow(
      /credentials/i,
    );
  });

  it('rejects an https URL pointing at a literal private/metadata IP', async () => {
    await expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private|internal|disallowed/i,
    );
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(
      /private|internal|disallowed/i,
    );
  });

  it('rejects garbage', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toThrow();
  });
});
