import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

describe('clientIp', () => {
  it('prefers the Express-resolved client over the socket peer', () => {
    // Behind the proxy the socket peer is always the proxy container; Express
    // resolves the real caller from X-Forwarded-For.
    expect(clientIp({ raw: { ip: '203.0.113.7' }, remoteAddress: '172.19.0.2' })).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the socket peer for unproxied requests', () => {
    // e.g. the container-local health probe, which never goes through Caddy.
    expect(clientIp({ raw: {}, remoteAddress: '127.0.0.1' })).toBe('127.0.0.1');
    expect(clientIp({ remoteAddress: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('returns undefined when neither is available', () => {
    expect(clientIp({})).toBeUndefined();
  });
});
