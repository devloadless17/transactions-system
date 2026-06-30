import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { W2WCryptoError, decryptSecret, encryptSecret, loadW2WKey } from './w2w-crypto';

const KEY = crypto.randomBytes(32);

describe('w2w-crypto (audit)', () => {
  it('round-trips a secret', () => {
    const ct = encryptSecret('session-token-xyz', KEY);
    expect(decryptSecret(ct, KEY)).toBe('session-token-xyz');
  });

  it('throws W2WCryptoError under the WRONG key (the prod failure mode)', () => {
    const ct = encryptSecret('session-token-xyz', KEY);
    const other = crypto.randomBytes(32);
    expect(() => decryptSecret(ct, other)).toThrow(W2WCryptoError);
  });

  it('throws W2WCryptoError on tampered ciphertext (GCM tag mismatch)', () => {
    const ct = encryptSecret('session-token-xyz', KEY);
    const raw = Buffer.from(ct, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(raw.toString('base64'), KEY)).toThrow(W2WCryptoError);
  });

  it('throws W2WCryptoError on a too-short blob', () => {
    expect(() => decryptSecret(Buffer.alloc(10).toString('base64'), KEY)).toThrow(W2WCryptoError);
  });

  it('loadW2WKey rejects a non-32-byte key', () => {
    expect(() => loadW2WKey(Buffer.alloc(16).toString('base64'))).toThrow(W2WCryptoError);
  });

  // CRITICAL: W2WCryptoError is a plain Error, NOT a DomainError/ValidationError/
  // WhishSessionExpiredError. The orchestrator branches on those classes; this
  // pins the class so a refactor that "promotes" it would be a deliberate choice.
  it('W2WCryptoError is a plain Error (no DomainError shape)', () => {
    const e = new W2WCryptoError('x');
    expect(e).toBeInstanceOf(Error);
    expect((e as unknown as { code?: unknown }).code).toBeUndefined();
    expect((e as unknown as { httpStatus?: unknown }).httpStatus).toBeUndefined();
  });
});
