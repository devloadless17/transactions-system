import crypto from 'node:crypto';

/**
 * Stateless, integrity-bound CSRF double-submit token.
 *
 * The token is `<nonce>.<hmac>` where `hmac = HMAC-SHA256(CSRF_SECRET, nonce)`.
 * The web client (and any integrator) still treats the whole string as an
 * opaque value: it reads the `csrf-token` cookie and echoes it back in the
 * `x-csrf-token` header, so the double-submit model is unchanged.
 *
 * Binding the token to CSRF_SECRET means rotating the secret invalidates every
 * outstanding token (the next mutating request gets one CSRF refresh — clients
 * already re-fetch `/auth/csrf` on a missing/invalid token), and a token can't
 * be forged without the server-side secret.
 */
const NONCE_BYTES = 32;

export function issueCsrfToken(secret: string): string {
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
  const mac = crypto.createHmac('sha256', secret).update(nonce).digest('hex');
  return `${nonce}.${mac}`;
}

/**
 * Verify a token was minted with `secret`. Constant-time on the HMAC compare so
 * the check leaks no timing signal. Returns false for any malformed token.
 */
export function verifyCsrfToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const nonce = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(nonce).digest('hex');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(macBuf, expectedBuf);
}
