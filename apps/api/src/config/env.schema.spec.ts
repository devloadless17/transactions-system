import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

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
  COOKIE_SECURE: 'true',
  COOKIE_DOMAIN: 'app.example.com',
  WEB_ORIGIN: 'https://app.example.com',
  ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
  JWT_ACCESS_SECRET: 'A'.repeat(40),
  JWT_REFRESH_SECRET: 'B'.repeat(40),
  CSRF_SECRET: 'C'.repeat(40),
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
});
