import { describe, expect, it } from 'vitest';
import { listCompaniesQuerySchema } from '@app/shared';
import { isLiveWhishBaseUrl, validateEnv } from './env.schema';

describe('listCompaniesQuerySchema.withBalances is permissive', () => {
  // A perf opt-in must never 400 the whole list on an unexpected value; only
  // 'true' opts in (checked at the controller).
  it.each(['1', 'yes', 'TRUE', 'false', '', 'anything'])('accepts %o', (v) => {
    expect(() => listCompaniesQuerySchema.parse({ withBalances: v })).not.toThrow();
  });

  it('omitting it is fine', () => {
    expect(listCompaniesQuerySchema.parse({}).withBalances).toBeUndefined();
  });
});

// A baseline that parses cleanly in development.
const base: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  CSRF_SECRET: 'c'.repeat(40),
};

// A production env that satisfies every hardening rule.
const prodOk: Record<string, string> = {
  ...base,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://txn_app_rls:Str0ng-Unique-Pw@db.internal:5432/txn',
  COOKIE_SECURE: 'true',
  COOKIE_DOMAIN: 'app.example.com',
  WEB_ORIGIN: 'https://app.example.com',
  ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
  METRICS_TOKEN: 'a-strong-metrics-token',
  JWT_ACCESS_SECRET: 'A'.repeat(40),
  JWT_REFRESH_SECRET: 'B'.repeat(40),
};

describe('validateEnv', () => {
  it('accepts dev defaults', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it('accepts a fully-hardened production env', () => {
    expect(() => validateEnv(prodOk)).not.toThrow();
  });

  it('rejects production with COOKIE_SECURE=false', () => {
    expect(() => validateEnv({ ...prodOk, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('rejects production with localhost cookie domain', () => {
    expect(() => validateEnv({ ...prodOk, COOKIE_DOMAIN: 'localhost' })).toThrow(/COOKIE_DOMAIN/);
  });

  it('rejects production with an http origin', () => {
    expect(() => validateEnv({ ...prodOk, WEB_ORIGIN: 'http://app.example.com' })).toThrow(
      /WEB_ORIGIN/,
    );
  });

  it('rejects production with a dev/default secret', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        JWT_ACCESS_SECRET: 'dev_access_secret_change_me_min_32_chars_xxxxx',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects production when access and refresh secrets are identical', () => {
    const same = 'Z'.repeat(40);
    expect(() =>
      validateEnv({ ...prodOk, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('requires CSRF_SECRET (>=32 chars) in every environment', () => {
    const { CSRF_SECRET: _omit, ...noCsrf } = base;
    expect(() => validateEnv(noCsrf)).toThrow(/CSRF_SECRET/);
    expect(() => validateEnv({ ...base, CSRF_SECRET: 'too-short' })).toThrow(/CSRF_SECRET/);
  });

  it('rejects production when CSRF_SECRET equals a JWT secret', () => {
    expect(() => validateEnv({ ...prodOk, CSRF_SECRET: prodOk.JWT_ACCESS_SECRET })).toThrow(
      /CSRF_SECRET/,
    );
  });

  it('rejects production with a dev/default CSRF secret', () => {
    expect(() =>
      validateEnv({ ...prodOk, CSRF_SECRET: 'dev_csrf_secret_change_me_min_32_chars_xxxxx' }),
    ).toThrow(/CSRF_SECRET/);
  });

  it('rejects production without a METRICS_TOKEN', () => {
    expect(() => validateEnv({ ...prodOk, METRICS_TOKEN: '' })).toThrow(/METRICS_TOKEN/);
  });

  it('rejects production using a default DB password', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        DATABASE_URL: 'postgresql://txn_app_rls:txn_app_rls_dev_password@db:5432/txn',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects production when ALLOWED_ORIGINS omits WEB_ORIGIN', () => {
    expect(() => validateEnv({ ...prodOk, ALLOWED_ORIGINS: 'https://admin.example.com' })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it('rejects production with a localhost WHISH_WEBSITE_URL when Whish is configured', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_CHANNEL: '10200239',
        WHISH_SECRET: 'whish-secret',
        WHISH_BASE_URL: 'https://api.whish.money/itel-service/api',
        WHISH_CALLBACK_BASE: 'https://api.example.com/v1',
        WHISH_WEBSITE_URL: 'http://localhost:3000',
      }),
    ).toThrow(/WHISH_WEBSITE_URL/);
  });

  // The production base-URL guard is an ALLOWLIST of the one live Whish host, not
  // a blacklist of "sandbox". The old blacklist matched the substring 'sandbox',
  // which the v1.4.4 sandbox host (partner.api.sbx.whish.money) slips past — a
  // prod build could then boot pointed at the sandbox and collect no real money.
  const whishProd = (over: Record<string, string>) => ({
    ...prodOk,
    WHISH_CHANNEL: '10200239',
    WHISH_SECRET: 'whish-secret',
    WHISH_CALLBACK_BASE: 'https://api.example.com/v1',
    WHISH_WEBSITE_URL: 'rival.com',
    ...over,
  });

  it.each([
    ['the live host', 'https://api.whish.money/itel-service/api'],
    ['the live host, uppercased', 'https://API.WHISH.MONEY/itel-service/api'],
  ])('accepts %s in production', (_label, WHISH_BASE_URL) => {
    expect(() =>
      validateEnv(whishProd({ WHISH_BASE_URL, WHISH_WEBSITE_URL: 'https://portal.example.com' })),
    ).not.toThrow();
  });

  it.each([
    ['the legacy sandbox host', 'https://api.sandbox.whish.money/itel-service/api'],
    // The v1.4.4 sandbox: contains 'sbx', not 'sandbox' — the regression this guard fix exists for.
    ['the v1.4.4 sandbox host', 'https://partner.api.sbx.whish.money/itel-service/api'],
    // Allowlist, not blacklist: a host we have never heard of must fail closed.
    ['an unknown future host', 'https://partner.api.uat.whish.money/itel-service/api'],
    ['a lookalike host', 'https://api.whish.money.evil.com/itel-service/api'],
    ['a subdomain lookalike', 'https://notapi.whish.money/itel-service/api'],
    // http would put the `secret:` header on the wire in cleartext.
    ['a plaintext http live host', 'http://api.whish.money/itel-service/api'],
  ])('rejects %s in production by default', (_label, WHISH_BASE_URL) => {
    expect(() => validateEnv(whishProd({ WHISH_BASE_URL }))).toThrow(/WHISH_BASE_URL/);
  });

  it('allows a non-production Whish host + bare website host when WHISH_ALLOW_SANDBOX=true', () => {
    expect(() =>
      validateEnv(
        whishProd({
          WHISH_ALLOW_SANDBOX: 'true',
          WHISH_BASE_URL: 'https://partner.api.sbx.whish.money/itel-service/api',
        }),
      ),
    ).not.toThrow();
  });

  it('still rejects a localhost callback even with WHISH_ALLOW_SANDBOX=true', () => {
    expect(() =>
      validateEnv(
        whishProd({
          WHISH_ALLOW_SANDBOX: 'true',
          WHISH_BASE_URL: 'https://partner.api.sbx.whish.money/itel-service/api',
          WHISH_CALLBACK_BASE: 'http://localhost:3001/v1',
        }),
      ),
    ).toThrow(/WHISH_CALLBACK_BASE/);
  });

  it('does not apply the base-URL guard when Whish is unconfigured', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_BASE_URL: 'https://partner.api.sbx.whish.money/itel-service/api',
      }),
    ).not.toThrow();
  });

  it('trims a trailing slash off WHISH_BASE_URL', () => {
    const env = validateEnv({
      ...prodOk,
      WHISH_BASE_URL: 'https://api.whish.money/itel-service/api/',
    });
    expect(env.WHISH_BASE_URL).toBe('https://api.whish.money/itel-service/api');
  });
});

describe('isLiveWhishBaseUrl', () => {
  it.each([
    ['https://api.whish.money/itel-service/api', true],
    ['https://API.WHISH.MONEY/itel-service/api', true],
    ['https://api.whish.money:443/itel-service/api', true],
    ['https://api.whish.money:8443/itel-service/api', false],
    ['http://api.whish.money/itel-service/api', false],
    ['https://partner.api.sbx.whish.money/itel-service/api', false],
    ['https://api.sandbox.whish.money/itel-service/api', false],
    ['https://api.whish.money.evil.com/itel-service/api', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (url, expected) => {
    expect(isLiveWhishBaseUrl(url)).toBe(expected);
  });
});

// W2W transfers move real money out of the platform's Whish account — the
// enabled-state refinements (https/public base URL, 44-char base64 enc key)
// were the only production fail-closed block without spec coverage
// (2026-07-03 audit). Pin them like the rest.
describe('WHISH_W2W production refinements', () => {
  const w2wOk: Record<string, string> = {
    WHISH_W2W_ENABLED: 'true',
    WHISH_W2W_BASE_URL: 'https://api.whish.money/itel-service',
    // openssl rand -base64 32 → 44 chars
    WHISH_W2W_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };

  it('accepts a fully-formed W2W config in production', () => {
    expect(() => validateEnv({ ...prodOk, ...w2wOk })).not.toThrow();
  });

  it('rejects a short (non-32-byte) WHISH_W2W_ENC_KEY when enabled', () => {
    expect(() => validateEnv({ ...prodOk, ...w2wOk, WHISH_W2W_ENC_KEY: 'too-short' })).toThrow(
      /WHISH_W2W_ENC_KEY/,
    );
  });

  it('rejects an http (non-https) W2W base URL when enabled', () => {
    expect(() =>
      validateEnv({ ...prodOk, ...w2wOk, WHISH_W2W_BASE_URL: 'http://api.whish.money/itel' }),
    ).toThrow(/WHISH_W2W_BASE_URL/);
  });

  it('rejects a localhost W2W base URL when enabled', () => {
    expect(() =>
      validateEnv({ ...prodOk, ...w2wOk, WHISH_W2W_BASE_URL: 'https://localhost:8443/itel' }),
    ).toThrow(/WHISH_W2W_BASE_URL/);
  });

  it('applies none of the W2W refinements when the feature is disabled', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_W2W_ENABLED: 'false',
        WHISH_W2W_ENC_KEY: 'short',
      }),
    ).not.toThrow();
  });
});

// Simulated auto-approval (staging) and real W2W transfers must never coexist —
// with both on, "auto-approved" could mean either "money sent" or "faked".
// The guard applies in EVERY environment (staging runs NODE_ENV=production).
describe('WITHDRAWAL_AUTO_APPROVAL_SIMULATE mutual exclusion with W2W', () => {
  const w2wOn: Record<string, string> = {
    WHISH_W2W_ENABLED: 'true',
    WHISH_W2W_BASE_URL: 'https://api.whish.money/itel-service',
    WHISH_W2W_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };

  it('accepts simulate alone (the staging setup)', () => {
    expect(() =>
      validateEnv({ ...prodOk, WITHDRAWAL_AUTO_APPROVAL_SIMULATE: 'true' }),
    ).not.toThrow();
    expect(validateEnv({ ...base, WITHDRAWAL_AUTO_APPROVAL_SIMULATE: 'true' })).toMatchObject({
      WITHDRAWAL_AUTO_APPROVAL_SIMULATE: true,
    });
  });

  it('defaults to off', () => {
    expect(validateEnv(base).WITHDRAWAL_AUTO_APPROVAL_SIMULATE).toBe(false);
  });

  it('rejects simulate together with WHISH_W2W_ENABLED in production', () => {
    expect(() =>
      validateEnv({ ...prodOk, ...w2wOn, WITHDRAWAL_AUTO_APPROVAL_SIMULATE: 'true' }),
    ).toThrow(/WITHDRAWAL_AUTO_APPROVAL_SIMULATE/);
  });

  it('rejects the pair even in development (guard is environment-independent)', () => {
    expect(() =>
      validateEnv({
        ...base,
        WHISH_W2W_ENABLED: 'true',
        WITHDRAWAL_AUTO_APPROVAL_SIMULATE: 'true',
      }),
    ).toThrow(/WITHDRAWAL_AUTO_APPROVAL_SIMULATE/);
  });
});

// Telegram alerts are all-or-nothing: a half-configured pair must fail closed so
// a typo surfaces at boot rather than as a silently-missed money request.
describe('Telegram alert env pairing', () => {
  it('accepts both Telegram vars left blank (feature off)', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it('accepts both Telegram vars set together', () => {
    expect(() =>
      validateEnv({ ...base, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-1001234567890' }),
    ).not.toThrow();
  });

  it('rejects a token without a chat id', () => {
    expect(() => validateEnv({ ...base, TELEGRAM_BOT_TOKEN: '123:abc' })).toThrow(
      /TELEGRAM_CHAT_ID/,
    );
  });

  it('rejects a chat id without a token', () => {
    expect(() => validateEnv({ ...base, TELEGRAM_CHAT_ID: '-1001234567890' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });
});
