import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, Request, Response } from 'express';
import { trustedProxies } from './trusted-proxies';

// The very Express the API runs on (it ships inside @nestjs/platform-express).
const requireFromNest = createRequire(
  createRequire(__filename).resolve('@nestjs/platform-express'),
);
const express = requireFromNest('express') as () => Express;

/**
 * What `req.ip` resolves to for a request arriving from the reverse proxy (the
 * test client connects over loopback, which stands in for Caddy on the container
 * network) carrying the given X-Forwarded-For.
 */
describe('trustedProxies → req.ip', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', trustedProxies({}));
    app.get('/ip', (req: Request, res: Response) => {
      res.json({ ip: req.ip });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

  async function ipFor(xff?: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/ip`, {
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
    return ((await res.json()) as { ip: string }).ip;
  }

  it('takes the ONE address the proxy hands over', async () => {
    expect(await ipFor('203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor('2001:db8::1234')).toBe('2001:db8::1234');
  });

  it('a visitor whose address is inside Cloudflare’s space is still just that address', async () => {
    // e.g. a Cloudflare Worker: the proxy reports Cloudflare's shared Worker
    // address, and every Worker therefore lands in the same rate-limit bucket.
    expect(await ipFor('2a06:98c0:3600::103')).toBe('2a06:98c0:3600::103');
    expect(await ipFor('172.69.22.87')).toBe('172.69.22.87');
  });

  it('never believes a caller-seeded chain: only the right-most hop counts', async () => {
    // If the proxy ever passed a chain through, the address we would resolve is
    // the one the proxy itself appended — not the forged entries to its left,
    // even when the hops in between are Cloudflare edges.
    expect(await ipFor('6.6.6.6, 203.0.113.7, 104.22.40.137')).toBe('104.22.40.137');
    expect(await ipFor('6.6.6.6, 2a06:98c0:3600::103')).toBe('2a06:98c0:3600::103');
  });

  it('the web server passing on its own health check lands in a bucket of its own', async () => {
    // The web container's health check renders a page, which calls this API.
    // Next reports its caller as loopback, the web server passes that on, and
    // every hop is then one we trust — so the furthest one is the answer. Real
    // visitors (above) never share a rate-limit budget with it.
    expect(await ipFor('127.0.0.1')).toBe('127.0.0.1');
    expect(await ipFor('::1')).toBe('::1');
  });

  it('with no header at all (the container health probe) it is the socket peer', async () => {
    expect(await ipFor()).toMatch(/127\.0\.0\.1$/);
  });
});

describe('trustedProxies', () => {
  it('trusts only the hop the API is attached to — the container network', () => {
    // Caddy reaches the API over the docker bridge (172.16/12 = uniquelocal);
    // the health probe comes from loopback. Without these the API would treat
    // its own reverse proxy as the client on every request.
    expect(trustedProxies({})).toEqual(['loopback', 'linklocal', 'uniquelocal']);
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
    }
  });
});
