import crypto from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for the captured Whish consumer-app session
 * secrets (token / uid / sessionid). The key is a base64-encoded 32-byte value
 * from `WHISH_W2W_ENC_KEY`, held only in env/secret-manager — never in the DB —
 * so a DB leak alone doesn't expose the session.
 *
 * Output format: base64( iv[12] || authTag[16] || ciphertext ). Self-describing,
 * so `decrypt` needs nothing but the key and the stored string.
 */
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

export class W2WCryptoError extends Error {}

export function loadW2WKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new W2WCryptoError(
      'WHISH_W2W_ENC_KEY must decode to exactly 32 bytes (run: openssl rand -base64 32)',
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new W2WCryptoError('stored W2W secret is malformed (too short)');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext.
    throw new W2WCryptoError('could not decrypt W2W session secret (wrong WHISH_W2W_ENC_KEY?)');
  }
}
