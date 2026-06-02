import { describe, expect, it, vi } from 'vitest';

// PrismaClient's constructor reads the datasource URL lazily (it does not
// connect here), so a placeholder is enough to instantiate the service under
// test without a database.
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';

import { PrismaService } from './prisma.service';

/** A transient serialization failure as Postgres surfaces it (SQLSTATE 40001). */
function serializationFailure(): Error {
  const e = new Error('could not serialize access due to concurrent update');
  (e as unknown as { code: string }).code = '40001';
  return e;
}

describe('PrismaService.runSerializable', () => {
  it('retries a transient serialization failure and eventually succeeds', async () => {
    const svc = new PrismaService();
    let calls = 0;
    vi.spyOn(svc, '$transaction' as never).mockImplementation((async (
      fn: (tx: unknown) => unknown,
    ) => {
      calls++;
      if (calls < 3) throw serializationFailure();
      return fn({});
    }) as never);

    const result = await svc.runSerializable(async () => 'ok');
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const svc = new PrismaService();
    let calls = 0;
    vi.spyOn(svc, '$transaction' as never).mockImplementation((async () => {
      calls++;
      throw new Error('some unrelated failure');
    }) as never);

    await expect(svc.runSerializable(async () => 'ok')).rejects.toThrow('some unrelated failure');
    expect(calls).toBe(1);
  });

  it('gives up after the max attempts on a persistent conflict', async () => {
    const svc = new PrismaService();
    let calls = 0;
    vi.spyOn(svc, '$transaction' as never).mockImplementation((async () => {
      calls++;
      throw serializationFailure();
    }) as never);

    await expect(svc.runSerializable(async () => 'ok')).rejects.toThrow(/serialize/);
    expect(calls).toBe(5);
  });
});
