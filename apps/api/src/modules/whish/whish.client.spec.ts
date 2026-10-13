import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhishClient, WhishError, WhishIndeterminateError, whishSafeText } from './whish.client';
import { ValidationError } from '../../common/errors/domain.error';

// Contract tests for the Whish Pay envelope, pinned against Whish Pay v1.4.4.
//
// Two properties matter most here, and both are money-safe distinctions the rest
// of the module leans on:
//   1. INDETERMINATE vs FAILED. `status:false` + `code:"500"`, a timeout and a
//      5xx all mean "the outcome is unknown" — v1.4.4 says in as many words "do
//      not mark it failed". Misclassifying one as a failure marks a link FAILED
//      that the customer may still pay (and the poller never re-checks a FAILED
//      row, so it is unrecoverable).
//   2. RECOGNISED vs UNRECOGNISED collectStatus. The five documented values must
//      pass through; a sixth, undocumented one must THROW rather than reach
//      reconcile(), where anything that isn't 'success' would be treated as a
//      settled non-collection.

const BASE = 'https://whish.example/itel-service/api';

const config = {
  get: (key: string) =>
    key === 'WHISH_BASE_URL'
      ? BASE
      : key === 'WHISH_CHANNEL'
        ? 'chan'
        : key === 'WHISH_SECRET'
          ? 'sec'
          : key === 'WHISH_WEBSITE_URL'
            ? 'rival.com'
            : 'UA/1.0',
} as never;

/** Last request body seen by the stubbed fetch, parsed. */
let lastBody: Record<string, unknown> | undefined;
/** Last request URL and method seen by the stubbed fetch. */
let lastUrl: string | undefined;
let lastMethod: string | undefined;

function mockWhish(status: number, body: unknown, contentIsJson = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      lastUrl = url;
      lastMethod = init?.method;
      lastBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => {
          if (!contentIsJson) throw new SyntaxError('Unexpected token < in JSON');
          return body;
        },
      };
    }),
  );
}

/** A Whish `status:true` envelope, including the v1.4.4 additive fields. */
const ok = <T>(data: T) => ({
  status: true,
  code: null,
  dialog: null,
  data,
  actions: null,
  extra: null,
  retrieved: false,
});

const fail = (code: string, message = 'something went wrong') => ({
  status: false,
  code,
  dialog: { title: 'Oops', message },
  data: null,
});

const payment = {
  amount: '1.00',
  currency: 'USD',
  invoice: 'Order #1',
  externalId: '900001',
  successCallbackUrl: 'https://example.com/cb/success',
  failureCallbackUrl: 'https://example.com/cb/failure',
  successRedirectUrl: 'https://example.com/paid',
  failureRedirectUrl: 'https://example.com/failed',
};

describe('WhishClient envelope handling', () => {
  let client: WhishClient;

  beforeEach(() => {
    client = new WhishClient(config);
    lastBody = undefined;
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('indeterminate vs failed', () => {
    it('classifies status:false + code "500" as INDETERMINATE, not failed', async () => {
      mockWhish(200, fail('500', 'service unavailable'));
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
      // Still a WhishError, so the super-admin transaction log keeps working.
      expect(err).toBeInstanceOf(WhishError);
      expect((err as WhishError).code).toBe('WHISH_PENDING');
      // The same status as every Whish failure — only `code` distinguishes it,
      // so no new HTTP status enters the integrator contract. 503, not 502:
      // Cloudflare replaces an origin 502 with its own page and the caller would
      // never see this JSON.
      expect((err as WhishError).httpStatus).toBe(503);
    });

    // The docs type `code` as a String but write the special value as `500`.
    it('classifies a NUMERIC code 500 as INDETERMINATE too', async () => {
      mockWhish(200, { ...fail('x'), code: 500 });
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
    });

    it('classifies an HTTP 5xx as INDETERMINATE even when the body is not JSON', async () => {
      mockWhish(503, '<html>gateway</html>', false);
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
    });

    it('classifies a request TIMEOUT as INDETERMINATE (the call was in flight)', async () => {
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw timeout;
        }),
      );
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
    });

    it('classifies a transport error that never reached Whish as a definite failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
        }),
      );
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishError);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
      expect((err as WhishError).code).toBe('WHISH_ERROR');
    });

    it('classifies a business failure code as FAILED', async () => {
      mockWhish(200, fail('currency.not_supported', 'Only LBP and USD are accepted'));
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishError);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
      // The upstream dialog message is relayed for non-auth failures.
      expect((err as WhishError).message).toBe('Only LBP and USD are accepted');
    });

    it('classifies an HTTP 400 as FAILED, not indeterminate', async () => {
      mockWhish(400, fail('400', 'bad request'));
      const err = await client.postPayment(payment).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
    });

    it.each(['auth.session_not_exist', 'auth.session_expired'])(
      'translates %s into an honest config message while keeping the raw code',
      async (code) => {
        mockWhish(200, fail(code, 'Please sign in again. You have been signed out.'));
        const err = (await client.postPayment(payment).catch((e: unknown) => e)) as WhishError;
        expect(err.message).toMatch(/not configured correctly/i);
        // The consumer-facing "you have been signed out" wording must not leak.
        expect(err.message).not.toMatch(/signed out/i);
        expect(err.details?.code).toBe(code);
      },
    );
  });

  describe('collectStatus contract', () => {
    it.each(['success', 'failed', 'pending', 'refunded', 'unknown'])(
      'passes through the documented status %s',
      async (collectStatus) => {
        mockWhish(200, ok({ collectStatus, payerPhoneNumber: 96170123456 }));
        const res = await client.getStatus({ currency: 'USD', externalId: '900001' });
        expect(res.collectStatus).toBe(collectStatus);
        // Whish sends the phone as a number; we normalise to a string.
        expect(res.payerPhoneNumber).toBe('96170123456');
      },
    );

    it('THROWS on an undocumented future status rather than letting it reach reconcile', async () => {
      mockWhish(200, ok({ collectStatus: 'partially_refunded' }));
      await expect(client.getStatus({ currency: 'USD', externalId: '900001' })).rejects.toThrow(
        /unrecognized collectStatus/i,
      );
    });

    // Verified against the live v1.4.4 sandbox: an unpaid link comes back with
    // payerPhoneNumber "" rather than null.
    it.each([['', null] as const, ['   ', null] as const, [null, null] as const])(
      'normalises a blank payerPhoneNumber %o to null',
      async (given, expected) => {
        mockWhish(200, ok({ collectStatus: 'pending', payerPhoneNumber: given }));
        const res = await client.getStatus({ currency: 'USD', externalId: '900001' });
        expect(res.payerPhoneNumber).toBe(expected);
      },
    );

    it('throws when collectStatus is missing entirely', async () => {
      mockWhish(200, ok({ payerPhoneNumber: null }));
      await expect(client.getStatus({ currency: 'USD', externalId: '900001' })).rejects.toThrow(
        /missing collectStatus/i,
      );
    });
  });

  describe('externalId is a String on the wire (v1.4.4)', () => {
    it('sends externalId as a JSON string on postPayment', async () => {
      mockWhish(200, ok({ collectUrl: 'https://whish.money/collect/abc' }));
      await client.postPayment(payment);
      expect(typeof lastBody?.externalId).toBe('string');
      expect(lastBody?.externalId).toBe('900001');
    });

    it('sends externalId as a JSON string on getStatus', async () => {
      mockWhish(200, ok({ collectStatus: 'pending' }));
      await client.getStatus({ currency: 'USD', externalId: '900001' });
      expect(typeof lastBody?.externalId).toBe('string');
    });

    it.each(['', 'abc', '12a', '1.5', '-1'])('rejects a non-digit externalId %o', async (id) => {
      mockWhish(200, ok({ collectStatus: 'pending' }));
      await expect(client.getStatus({ currency: 'USD', externalId: id })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // POST /payment/whish/refund (v1.4.3+). A refund moves real money back to the
  // payer, so the classification matters even more than on create: booking a
  // refund Whish refused would claw money from a company for nothing, and
  // treating an unknown outcome as a refusal invites a SECOND refund.
  describe('refund', () => {
    const refund = { currency: 'USD', externalId: '900001', refundReason: 'Customer cancelled' };

    it('sends the documented body to the refund endpoint', async () => {
      // The documented success reply: data is null, plus the additive fields.
      mockWhish(200, ok(null));
      await expect(client.refund(refund)).resolves.toEqual({ alreadyProcessed: false });
      expect(lastUrl).toBe(`${BASE}/payment/whish/refund`);
      expect(lastMethod).toBe('POST');
      expect(lastBody).toEqual({
        currency: 'USD',
        externalId: '900001',
        refundReason: 'Customer cancelled',
      });
      expect(typeof lastBody?.externalId).toBe('string');
    });

    // v1.4.4 "Already processed": a duplicate refund replays as status:true with
    // `retrieved: true` — still a success, and the payer is not paid twice.
    it('reports a refund Whish had already processed (retrieved: true)', async () => {
      mockWhish(200, { ...ok(null), retrieved: true });
      await expect(client.refund(refund)).resolves.toEqual({ alreadyProcessed: true });
    });

    it('strips characters Whish cannot store from the reason, and omits an empty one', async () => {
      mockWhish(200, ok(null));
      await client.refund({ ...refund, refundReason: 'Customer cancelled 🎉' });
      expect(lastBody?.refundReason).toBe('Customer cancelled');
      await client.refund({ ...refund, refundReason: '🎉🎉' });
      expect(lastBody).not.toHaveProperty('refundReason'); // optional at Whish
    });

    // v1.4.4 "IP whitelisting": refunds are only accepted from registered IPs.
    it('an auth.* refusal is explained as our IP not being allowlisted — not "invalid credentials"', async () => {
      mockWhish(200, fail('auth.error', 'An error has occurred, please try again later.'));
      const err = (await client.refund(refund).catch((e: unknown) => e)) as WhishError;
      expect(err).toBeInstanceOf(WhishError);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
      expect(err.message).toMatch(/refused the refund as not authorized/i);
      expect(err.message).toMatch(/allowlist this server's public IP/i);
      expect(err.message).not.toMatch(/invalid or expired credentials/i);
      expect(err.details?.code).toBe('auth.error');
      expect(err.httpStatus).toBe(503);
    });

    it('is a definite failure when Whish refuses it', async () => {
      mockWhish(200, fail('payment.not_refundable', 'This payment cannot be refunded'));
      const err = await client.refund(refund).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishError);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
      expect((err as WhishError).message).toBe('This payment cannot be refunded');
    });

    it('is INDETERMINATE on code "500" — the refund may have gone through', async () => {
      mockWhish(200, fail('500', 'service unavailable'));
      const err = await client.refund(refund).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
    });

    it('is INDETERMINATE on an HTTP 5xx', async () => {
      mockWhish(502, '<html>bad gateway</html>', false);
      const err = await client.refund(refund).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhishIndeterminateError);
    });

    it('rejects a non-digit externalId before calling Whish', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(client.refund({ ...refund, externalId: 'abc' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // v1.4.4 error reference: `emoji.not_supported` — "Payload contained
  // characters the database rejects (for example emoji). Strip unsupported
  // characters, then retry." Stripped before sending, so an emoji in an invoice
  // never costs a company its customer's payment.
  describe('text Whish cannot store', () => {
    it('strips emoji and other non-BMP characters, keeping every script Whish accepts', () => {
      expect(whishSafeText('Order #12 🎉 paid')).toBe('Order #12 paid');
      expect(whishSafeText('طلب رقم ١٢ ✅')).toBe('طلب رقم ١٢ ✅'); // Arabic + BMP symbols stay
      expect(whishSafeText('  MT5 5000123 • OWM-E6  ')).toBe('MT5 5000123 • OWM-E6');
      expect(whishSafeText('🚀')).toBe('');
    });

    it('sends the invoice made safe, and leaves an empty one out (it is optional)', async () => {
      mockWhish(200, ok({ collectUrl: 'https://whish.money/collect/abc' }));
      await client.postPayment({ ...payment, invoice: 'Deposit 💸 #88' });
      expect(lastBody?.invoice).toBe('Deposit #88');
      await client.postPayment({ ...payment, invoice: '💸' });
      expect(lastBody).not.toHaveProperty('invoice');
    });
  });

  // v1.4.4: a non-public callback/redirect URL is refused with HTTP 403 and an
  // HTML page, not the envelope.
  describe('HTTP 403 with an HTML body', () => {
    it('is a definite failure that says what Whish means by it', async () => {
      mockWhish(403, '<html>Forbidden</html>', false);
      const err = (await client.postPayment(payment).catch((e: unknown) => e)) as WhishError;
      expect(err).toBeInstanceOf(WhishError);
      expect(err).not.toBeInstanceOf(WhishIndeterminateError);
      expect(err.message).toMatch(/not publicly reachable/i);
    });
  });

  describe('misc', () => {
    it('ignores the additive v1.4.4 envelope fields and unwraps data', async () => {
      mockWhish(200, ok({ collectUrl: 'https://whish.money/collect/abc' }));
      await expect(client.postPayment(payment)).resolves.toEqual({
        collectUrl: 'https://whish.money/collect/abc',
      });
    });

    it('errors when a successful envelope carries no collectUrl', async () => {
      mockWhish(200, ok(null));
      await expect(client.postPayment(payment)).rejects.toThrow(/did not return a collect URL/i);
    });

    it('throws instead of silently reporting a $0.00 balance', async () => {
      mockWhish(200, ok({}));
      await expect(client.getBalance('USD')).rejects.toThrow(/did not return a balance/i);
    });

    it('returns a real balance', async () => {
      mockWhish(200, ok({ balance: 1234.56 }));
      await expect(client.getBalance('USD')).resolves.toEqual({ balance: 1234.56 });
    });

    it('refuses to call Whish at all when unconfigured', async () => {
      const unconfigured = new WhishClient({ get: () => '' } as never);
      await expect(unconfigured.getBalance('USD')).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
