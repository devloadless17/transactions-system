import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { noStore } from './no-store';

describe('noStore', () => {
  it('forbids any cache from storing a tenant-scoped response', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response;
    const next = vi.fn();

    noStore({} as Request, res, next as unknown as NextFunction);

    // no-store, not no-cache: a stored-then-revalidated copy is still a copy of
    // one tenant's data sitting in a shared cache.
    expect(headers['Cache-Control']).toBe('no-store, private');
    expect(headers['Vary']).toBe('Cookie, Authorization');
    expect(next).toHaveBeenCalledOnce();
  });
});
