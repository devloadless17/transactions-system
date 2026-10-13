import { describe, expect, it } from 'vitest';
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  errorReference,
  isChunkLoadError,
  shouldAutoReload,
} from './error-recovery';

describe('isChunkLoadError', () => {
  it('recognises every browser’s "could not download this code" error', () => {
    for (const e of [
      { name: 'ChunkLoadError', message: 'Loading chunk 6142 failed.' },
      {
        name: 'Error',
        message: 'Loading chunk 6142 failed.\n(error: https://x/_next/static/chunks/6142.js)',
      },
      { name: 'Error', message: 'Loading CSS chunk 311 failed.' },
      { name: 'TypeError', message: 'Failed to fetch dynamically imported module: https://x/a.js' },
      { name: 'TypeError', message: 'error loading dynamically imported module' },
      { name: 'TypeError', message: 'Importing a module script failed.' },
    ]) {
      expect(isChunkLoadError(e), e.message).toBe(true);
    }
  });

  it('leaves every other failure alone — those must not trigger a reload', () => {
    for (const e of [
      { name: 'Error', message: 'An error occurred in the Server Components render.' },
      { name: 'TypeError', message: "Cannot read properties of undefined (reading 'map')" },
      { name: 'TypeError', message: 'Failed to fetch' },
      { name: 'Error', message: '' },
      {},
    ]) {
      expect(isChunkLoadError(e), String(e.message)).toBe(false);
    }
  });
});

describe('shouldAutoReload', () => {
  it('reloads the first time, then not again within the cooldown — no reload loop', () => {
    const now = 5_000_000;
    expect(shouldAutoReload(0, now)).toBe(true);
    expect(shouldAutoReload(now - 1_000, now)).toBe(false);
    expect(shouldAutoReload(now - CHUNK_RELOAD_COOLDOWN_MS + 1, now)).toBe(false);
    expect(shouldAutoReload(now - CHUNK_RELOAD_COOLDOWN_MS, now)).toBe(true);
  });
});

describe('errorReference', () => {
  it('uses the digest for a server failure — it matches the web server log line', () => {
    expect(
      errorReference({ name: 'Error', message: 'An error occurred…', digest: '1234567' }),
    ).toEqual({
      label: 'Reference',
      value: '1234567',
    });
  });

  it('shows name and message for a browser failure, capped in length', () => {
    expect(errorReference({ name: 'TypeError', message: 'x is undefined' })).toEqual({
      label: 'Details',
      value: 'TypeError: x is undefined',
    });
    const long = errorReference({ name: 'Error', message: 'a'.repeat(500) });
    expect(long.value.length).toBe(200);
    expect(long.value.endsWith('…')).toBe(true);
  });
});
