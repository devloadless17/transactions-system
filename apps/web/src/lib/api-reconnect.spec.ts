import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithReconnect, isRetryableFetchFailure } from './api-reconnect';

/**
 * The web server's own calls to the API must ride out an API restart (a deploy)
 * instead of failing the page — but never repeat a request the API may have
 * acted on. These errors are the exact shapes Node's fetch throws.
 */
const fetchFailed = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('isRetryableFetchFailure', () => {
  it('retries any method while the API cannot be connected to — nothing was sent', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isRetryableFetchFailure(fetchFailed(code), 'GET'), code).toBe(true);
      expect(isRetryableFetchFailure(fetchFailed(code), 'POST'), code).toBe(true);
    }
  });

  it('retries a dropped connection for GET only — the API may have seen it', () => {
    for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']) {
      expect(isRetryableFetchFailure(fetchFailed(code), 'GET'), code).toBe(true);
      expect(isRetryableFetchFailure(fetchFailed(code), 'get'), code).toBe(true);
      expect(isRetryableFetchFailure(fetchFailed(code), 'POST'), code).toBe(false);
    }
  });

  it('never retries a failure it cannot identify', () => {
    expect(isRetryableFetchFailure(new TypeError('fetch failed'), 'GET')).toBe(false);
    expect(isRetryableFetchFailure(fetchFailed('ERR_SOMETHING_ELSE'), 'GET')).toBe(false);
    expect(isRetryableFetchFailure(new DOMException('aborted', 'AbortError'), 'GET')).toBe(false);
    expect(isRetryableFetchFailure(null, 'GET')).toBe(false);
    expect(isRetryableFetchFailure('ECONNREFUSED', 'GET')).toBe(false);
  });
});

describe('fetchWithReconnect', () => {
  // A fake clock: sleeping advances it, so the 15s window is tested instantly.
  function clock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it('keeps trying while the API is down, then returns its answer', async () => {
    const c = clock();
    const ok = new Response('{}', { status: 200 });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed('ENOTFOUND')) //     container being swapped
      .mockRejectedValueOnce(fetchFailed('ECONNREFUSED')) //  not listening yet
      .mockResolvedValueOnce(ok);
    await expect(
      fetchWithReconnect('http://api/v1/auth/me', {}, { fetchImpl, ...c }),
    ).resolves.toBe(ok);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns whatever the API answered — a 429 or 5xx is not retried', async () => {
    const c = clock();
    for (const status of [401, 429, 500, 503]) {
      const res = new Response('{}', { status });
      const fetchImpl = vi.fn().mockResolvedValue(res);
      await expect(fetchWithReconnect('http://api/x', {}, { fetchImpl, ...c })).resolves.toBe(res);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after the window and throws the real error', async () => {
    const c = clock();
    const err = fetchFailed('ECONNREFUSED');
    const fetchImpl = vi.fn().mockRejectedValue(err);
    const start = c.now();
    await expect(
      fetchWithReconnect(
        'http://api/x',
        {},
        { fetchImpl, ...c, windowMs: 15_000, intervalMs: 250 },
      ),
    ).rejects.toBe(err);
    expect(c.now() - start).toBeLessThanOrEqual(15_000);
    expect(fetchImpl).toHaveBeenCalledTimes(61); // the first try + one every 250ms for 15s
  });

  it('does not repeat a POST whose connection dropped', async () => {
    const c = clock();
    const err = fetchFailed('UND_ERR_SOCKET');
    const fetchImpl = vi.fn().mockRejectedValue(err);
    await expect(
      fetchWithReconnect('http://api/v1/auth/refresh', { method: 'POST' }, { fetchImpl, ...c }),
    ).rejects.toBe(err);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('really goes back to the network past Next’s per-render GET memoization', async () => {
    // Next hands a repeated GET (same URL, same render) the FIRST call's promise —
    // even a rejected one — unless the request carries a signal. Found live: the
    // retries never left the web server and the page still failed.
    const c = clock();
    const ok = new Response('{}', { status: 200 });
    const network = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed('ECONNREFUSED'))
      .mockResolvedValue(ok);
    const memo = new Map<string, Promise<Response>>();
    const nextFetch = ((url: string, init?: RequestInit) => {
      if (init?.signal) return network(url, init);
      if (!memo.has(url)) memo.set(url, network(url, init));
      return memo.get(url)!;
    }) as typeof fetch;

    await expect(
      fetchWithReconnect('http://api/v1/auth/me', {}, { fetchImpl: nextFetch, ...c }),
    ).resolves.toBe(ok);
    expect(network).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithReconnect against a real socket', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it('waits for an API that starts listening after the request began', async () => {
    // Reserve a free port, release it, and bring the "API" up on it 600ms later.
    const probe = createTcpServer().listen(0, '127.0.0.1');
    await new Promise((r) => probe.once('listening', r));
    const { port } = probe.address() as AddressInfo;
    await new Promise((r) => probe.close(r));

    setTimeout(() => {
      server = createServer((_req, res) => res.end('back')).listen(port, '127.0.0.1');
    }, 600);

    const res = await fetchWithReconnect(`http://127.0.0.1:${port}/v1/auth/me`, {});
    expect(await res.text()).toBe('back');
  });
});
