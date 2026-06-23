import { describe, expect, it } from 'vitest';
import { issueCsrfToken, verifyCsrfToken } from './csrf.token';

const SECRET = 'test-csrf-secret-0123456789';

describe('csrf token', () => {
  it('round-trips: a freshly issued token verifies against the same secret', () => {
    const token = issueCsrfToken(SECRET);
    expect(token).toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);
    expect(verifyCsrfToken(token, SECRET)).toBe(true);
  });

  it('rejects a token minted with a DIFFERENT secret (secret rotation invalidates tokens)', () => {
    const token = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(token, 'a-different-secret')).toBe(false);
  });

  it('rejects a tampered nonce (HMAC no longer matches)', () => {
    const token = issueCsrfToken(SECRET);
    const [nonce, mac] = token.split('.');
    const tampered = `${nonce}0.${mac}`;
    expect(verifyCsrfToken(tampered, SECRET)).toBe(false);
  });

  it('rejects a tampered mac', () => {
    const token = issueCsrfToken(SECRET);
    const [nonce, mac] = token.split('.');
    const flipped = mac!.slice(0, -1) + (mac!.endsWith('0') ? '1' : '0');
    expect(verifyCsrfToken(`${nonce}.${flipped}`, SECRET)).toBe(false);
  });

  it('rejects malformed / missing tokens', () => {
    expect(verifyCsrfToken(undefined, SECRET)).toBe(false);
    expect(verifyCsrfToken('', SECRET)).toBe(false);
    expect(verifyCsrfToken('nodot', SECRET)).toBe(false);
    expect(verifyCsrfToken('.leadingdot', SECRET)).toBe(false);
    expect(verifyCsrfToken('trailingdot.', SECRET)).toBe(false);
  });

  it('does not throw on a mac of the wrong length (length-guarded before timingSafeEqual)', () => {
    const token = issueCsrfToken(SECRET);
    const [nonce] = token.split('.');
    expect(() => verifyCsrfToken(`${nonce}.deadbeef`, SECRET)).not.toThrow();
    expect(verifyCsrfToken(`${nonce}.deadbeef`, SECRET)).toBe(false);
  });
});
