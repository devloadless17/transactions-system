import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

// A baseline that parses cleanly in development.
const base: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
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

  it('rejects the Whish sandbox in production by default', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_CHANNEL: '10200239',
        WHISH_SECRET: 'whish-secret',
        WHISH_BASE_URL: 'https://api.sandbox.whish.money/itel-service/api',
        WHISH_CALLBACK_BASE: 'https://api.example.com/v1',
        WHISH_WEBSITE_URL: 'rival.com',
      }),
    ).toThrow(/WHISH_BASE_URL/);
  });

  it('allows the Whish sandbox + bare website host when WHISH_ALLOW_SANDBOX=true', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_ALLOW_SANDBOX: 'true',
        WHISH_CHANNEL: '10200239',
        WHISH_SECRET: 'whish-secret',
        WHISH_BASE_URL: 'https://api.sandbox.whish.money/itel-service/api',
        WHISH_CALLBACK_BASE: 'https://api.example.com/v1',
        WHISH_WEBSITE_URL: 'rival.com',
      }),
    ).not.toThrow();
  });

  it('still rejects a localhost callback even with WHISH_ALLOW_SANDBOX=true', () => {
    expect(() =>
      validateEnv({
        ...prodOk,
        WHISH_ALLOW_SANDBOX: 'true',
        WHISH_CHANNEL: '10200239',
        WHISH_SECRET: 'whish-secret',
        WHISH_BASE_URL: 'https://api.sandbox.whish.money/itel-service/api',
        WHISH_CALLBACK_BASE: 'http://localhost:3001/v1',
        WHISH_WEBSITE_URL: 'rival.com',
      }),
    ).toThrow(/WHISH_CALLBACK_BASE/);
  });
});
