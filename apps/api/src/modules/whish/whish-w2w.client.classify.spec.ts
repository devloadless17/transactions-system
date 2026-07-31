import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhishW2WClient, WhishSessionExpiredError } from './whish-w2w.client';
import type { ResolvedW2WSession } from './whish-session.store';

// The classifier under test lives inside submit(): does a Whish reply become a
// thrown WhishSessionExpiredError (session outage → trips the breaker, pauses the
// whole withdrawal queue) or a clean `failed` outcome (single-transfer business
// failure → back to manual, full response captured)? The distinction is money-safe
// either way, but a false "session expired" wrongly pauses every withdrawal and
// misdirects the operator, so it must be reserved for GENUINE session failures.

const config = {
  get: (key: string) =>
    key === 'WHISH_W2W_BASE_URL' ? 'https://w2w.example' : key === 'WHISH_W2W_ENABLED' ? true : '',
} as never;

const session: ResolvedW2WSession = {
  token: 't',
  uid: 'u',
  sessionId: 's',
  deviceId: 'd',
  serverId: 'srv',
  itelVersion: '1',
  osVersion: '1',
  operatingSystem: 'ios',
  userAgent: 'ua',
  sessionCounter: 1,
};

function mockWhish(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      json: async () => body,
    })),
  );
}

describe('WhishW2WClient.submit classification', () => {
  let client: WhishW2WClient;

  beforeEach(() => {
    client = new WhishW2WClient(config);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats a malformed-recipient validation code as a clean business failure, NOT a session expiry', async () => {
    // The exact reply that tripped the breaker in prod: HTTP 200 + status:false,
    // code namespaced under `auth.` but describing the request payload.
    mockWhish(200, {
      status: false,
      code: 'auth.wrong_phone_format',
      dialog: { title: 'Error', message: 'Wrong phone number format: 7117886' },
    });

    const result = await client.submit({ phone: '7117886', amount: '50.00', session });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    // The real Whish response is preserved for the operator instead of discarded.
    expect(result.code).toBe('auth.wrong_phone_format');
    expect(result.message).toBe('Wrong phone number format: 7117886');
    expect(result.response).toMatchObject({ code: 'auth.wrong_phone_format' });
  });

  it('still throws on a genuine session-code reply (HTTP 200)', async () => {
    mockWhish(200, {
      status: false,
      code: 'auth.session_expired',
      dialog: { title: 'Error', message: 'Please sign in again' },
    });
    await expect(client.submit({ phone: '9613702825', amount: '50.00', session })).rejects.toThrow(
      WhishSessionExpiredError,
    );
  });

  it('still throws on 401/403 regardless of code', async () => {
    mockWhish(401, { status: false, code: 'auth.wrong_phone_format' });
    await expect(client.submit({ phone: '9613702825', amount: '50.00', session })).rejects.toThrow(
      WhishSessionExpiredError,
    );
  });

  it('still throws on a "sign in again" dialog message with no code', async () => {
    mockWhish(200, {
      status: false,
      code: null,
      dialog: { title: 'Error', message: 'Your session expired, please sign in again' },
    });
    await expect(client.submit({ phone: '9613702825', amount: '50.00', session })).rejects.toThrow(
      WhishSessionExpiredError,
    );
  });
});
