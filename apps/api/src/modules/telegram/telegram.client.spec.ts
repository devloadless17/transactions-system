import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { TelegramClient } from './telegram.client';

const DEFAULTS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  TELEGRAM_CHAT_ID: '-1001234567890',
  WEB_ORIGIN: 'https://app.example.com',
};

function makeClient(over: Record<string, string> = {}): TelegramClient {
  const values = { ...DEFAULTS, ...over };
  const config = {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService<Env, true>;
  return new TelegramClient(config);
}

function okResponse() {
  return { ok: true, status: 200, text: () => Promise.resolve('') };
}
function errResponse(status: number) {
  return { ok: false, status, text: () => Promise.resolve(`error ${status}`) };
}

const REQ = {
  flow: 'PAYOUT' as const,
  companyName: 'Acme',
  amount: '5000.00',
  currency: 'USD',
  entityId: 'req-1',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TelegramClient', () => {
  it('does not send when the bot token is blank', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await makeClient({ TELEGRAM_BOT_TOKEN: '' }).notifyRequest(REQ);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send when the chat id is blank', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await makeClient({ TELEGRAM_CHAT_ID: '' }).notifyRequest(REQ);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a well-formed, HTML-escaped message with a dashboard link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().notifyRequest({
      ...REQ,
      flow: 'LOAD',
      companyName: 'Tom & <b>Jerry</b>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123456:ABC-DEF/sendMessage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe('-1001234567890');
    expect(body.parse_mode).toBe('HTML');
    expect(body.disable_web_page_preview).toBe(true);
    // Company name is user-controlled → its markup must be escaped, not rendered.
    expect(body.text).toContain('Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;');
    expect(body.text).not.toContain('<b>Jerry');
    expect(body.text).toContain('5000.00 USD');
    expect(body.text).toContain('https://app.example.com/admin/loads');
    expect(body.text).toContain('🔵 New LOAD request');
  });

  it('links to the payouts page for a payout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().notifyRequest(REQ);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('https://app.example.com/admin/payouts');
    expect(body.text).toContain('🟢 New PAYOUT request');
  });

  it('falls back to "A company" when the name is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().notifyRequest({ ...REQ, companyName: null });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('A company');
  });

  it('retries a 5xx and succeeds on the next attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().notifyRequest(REQ);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a permanent 4xx (bad token / chat id)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient().notifyRequest(REQ)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders a WITHDRAWAL alert with the reason and the withdrawals link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await makeClient().notifyRequest({
      flow: 'WITHDRAWAL',
      companyName: 'Acme',
      amount: '620.00',
      currency: 'USD',
      entityId: 'w-1',
      reason: 'above cap (610.00 > 500 USD)',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('🟠 New WITHDRAWAL request');
    expect(body.text).toContain('needs manual approval');
    expect(body.text).toContain('Reason: above cap (610.00 &gt; 500 USD)');
    expect(body.text).toContain('https://app.example.com/admin/withdrawals');
  });

  it('escapes HTML in the reason (it is interpolated into the message)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().notifyRequest({
      flow: 'WITHDRAWAL',
      companyName: 'Acme',
      amount: '5',
      currency: 'USD',
      entityId: 'w-2',
      reason: '<b>CASH</b> & co',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('&lt;b&gt;CASH&lt;/b&gt; &amp; co');
    expect(body.text).not.toContain('<b>CASH</b>');
  });

  it('omits the Reason line entirely when no reason is given (load/payout)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeClient().notifyRequest(REQ);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).not.toContain('Reason:');
  });

  it('never throws when the network keeps failing; gives up after 3 attempts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const p = makeClient().notifyRequest(REQ);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
