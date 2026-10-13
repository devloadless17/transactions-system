import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domain.error';
import { corsOriginCheck } from './cors-origin';

const ALLOWED = ['https://portal.example.com', 'https://staging-portal.example.com'];

function check(origin: string | undefined): { err: Error | null; allow?: boolean } {
  let out: { err: Error | null; allow?: boolean } = { err: null };
  corsOriginCheck(ALLOWED)(origin, (err, allow) => {
    out = { err, allow };
  });
  return out;
}

describe('corsOriginCheck', () => {
  it('lets through a call with no Origin (server-to-server: API keys, curl, health checks)', () => {
    expect(check(undefined)).toEqual({ err: null, allow: true });
  });

  it('lets through an allowlisted origin', () => {
    expect(check('https://staging-portal.example.com')).toEqual({ err: null, allow: true });
  });

  it('refuses any other origin as a 403 FORBIDDEN — never a 500', () => {
    const { err } = check('https://evil.example.org');
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    expect(err?.message).toBe('Origin https://evil.example.org not allowed');
  });

  it.each([
    'https://staging.portal.example.com', // a renamed host's old name
    'http://portal.example.com', // right host, wrong scheme
    'https://portal.example.com.evil.org', // allowlisted name as a prefix
    'https://portal.example.com:8443', // right host, another port
  ])('matches exactly: %s is refused', (origin) => {
    expect(check(origin).err).toMatchObject({ httpStatus: 403 });
  });
});
