import { describe, expect, it } from 'vitest';

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

type TxFn = <T>(fn: (tx: unknown) => Promise<T> | T, opts?: unknown) => Promise<T>;

/** Replace the inherited interactive-transaction method with a test stub. */
function stubTransaction(svc: PrismaService, impl: TxFn): void {
  (svc as unknown as { $transaction: TxFn }).$transaction = impl;
}

describe('PrismaService.runSerializable', () => {
  it('retries a transient serialization failure and eventually succeeds', async () => {
    const svc = new PrismaService();
    let calls = 0;
    stubTransaction(svc, async (fn) => {
      calls++;
      if (calls < 3) throw serializationFailure();
      return fn({});
    });

    const result = await svc.runSerializable(async () => 'ok');
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const svc = new PrismaService();
    let calls = 0;
    stubTransaction(svc, async () => {
      calls++;
      throw new Error('some unrelated failure');
    });

    await expect(svc.runSerializable(async () => 'ok')).rejects.toThrow('some unrelated failure');
    expect(calls).toBe(1);
  });

  it('gives up after the max attempts on a persistent conflict', async () => {
    const svc = new PrismaService();
    let calls = 0;
    stubTransaction(svc, async () => {
      calls++;
      throw serializationFailure();
    });

    const t0 = performance.now();
    await expect(svc.runSerializable(async () => 'ok')).rejects.toThrow(/serialize/);
    expect(calls).toBe(8);
    // Long enough to outlast a blue/green switch, where two instances briefly
    // write for the same company (~200ms).
    expect(performance.now() - t0).toBeGreaterThan(1_000);
  });
});
