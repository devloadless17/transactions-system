import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import argon2 from 'argon2';
import type { PrismaService } from '../../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ApiKeysService } from './api-keys.service';

/**
 * API-key verification remembers a key that already passed argon2, so a busy
 * integration is not throttled by argon2's deliberate slowness. The memo must
 * never change WHO gets in: revocation and expiry are still decided live on
 * every request, and a wrong key is still refused.
 */
type Row = {
  id: string;
  companyId: string | null;
  sourceId: string | null;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

const COMPANY = { kind: 'company' as const, companyId: '00000000-0000-4000-8000-000000000001' };

function setup() {
  const rows: Row[] = [];
  const lastUsedWrites: string[] = [];
  const tx = {
    apiKey: {
      create: vi.fn(
        ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'> }) => {
          const row: Row = {
            ...data,
            id: `key-${rows.length + 1}`,
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
          };
          rows.push(row);
          return Promise.resolve(row);
        },
      ),
      // The live candidate query: same filter as the service's where-clause.
      findMany: vi.fn(({ where }: { where: { keyPrefix: string } }) =>
        Promise.resolve(
          rows.filter(
            (r) =>
              r.keyPrefix === where.keyPrefix &&
              r.revokedAt === null &&
              (r.expiresAt === null || r.expiresAt > new Date()),
          ),
        ),
      ),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        if ('lastUsedAt' in data) lastUsedWrites.push(where.id);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };
  const prisma = { runAsAdmin: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const realtime = { company: vi.fn(), admin: vi.fn() };
  const service = new ApiKeysService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
  );
  return { service, rows, lastUsedWrites };
}

let argonVerify: MockInstance<typeof argon2.verify>;

beforeEach(() => {
  argonVerify = vi.spyOn(argon2, 'verify');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ApiKeysService.verify — remembered keys', () => {
  it('a valid key is argon2-checked once, then answered from memory', async () => {
    const { service } = setup();
    const { plaintext } = await service.create(COMPANY, { name: 'crm' });

    for (let i = 0; i < 5; i++) {
      await expect(service.verify(plaintext)).resolves.toMatchObject({
        companyId: COMPANY.companyId,
        keyId: 'key-1',
      });
    }
    expect(argonVerify).toHaveBeenCalledTimes(1);
  });

  it('a burst with a not-yet-remembered key shares ONE argon2 check', async () => {
    const { service } = setup();
    const { plaintext } = await service.create(COMPANY, { name: 'crm' });

    const results = await Promise.all(Array.from({ length: 50 }, () => service.verify(plaintext)));

    expect(results.every((r) => r?.keyId === 'key-1')).toBe(true);
    expect(argonVerify).toHaveBeenCalledTimes(1);
  });

  it('a burst of one wrong key shares one check too — and all of it is refused', async () => {
    const { service } = setup();
    const { plaintext } = await service.create(COMPANY, { name: 'crm' });
    const [product, prefix] = plaintext.split('_');
    const wrong = `${product}_${prefix}_${'f'.repeat(64)}`;

    const results = await Promise.all(Array.from({ length: 20 }, () => service.verify(wrong)));

    expect(results.every((r) => r === null)).toBe(true);
    expect(argonVerify).toHaveBeenCalledTimes(1);
    // Nothing was remembered for it: the next attempt is checked afresh.
    await expect(service.verify(wrong)).resolves.toBeNull();
    expect(argonVerify).toHaveBeenCalledTimes(2);
  });

  it('a revoked key is refused at once, even though it was remembered', async () => {
    const { service } = setup();
    const { plaintext, apiKey } = await service.create(COMPANY, { name: 'crm' });
    await expect(service.verify(plaintext)).resolves.not.toBeNull();

    await service.revoke(COMPANY, apiKey.id);

    await expect(service.verify(plaintext)).resolves.toBeNull();
  });

  it('a rotated key is refused at once; its replacement works', async () => {
    const { service } = setup();
    const old = await service.create(COMPANY, { name: 'crm' });
    await expect(service.verify(old.plaintext)).resolves.not.toBeNull();

    const fresh = await service.rotate(COMPANY, old.apiKey.id);

    await expect(service.verify(old.plaintext)).resolves.toBeNull();
    await expect(service.verify(fresh.plaintext)).resolves.toMatchObject({ keyId: 'key-2' });
  });

  it('an expired key is refused, even though it was remembered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service } = setup();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const { plaintext } = await service.create(COMPANY, { name: 'crm', expiresAt });
    await expect(service.verify(plaintext)).resolves.not.toBeNull();

    vi.setSystemTime(Date.now() + 61_000);

    await expect(service.verify(plaintext)).resolves.toBeNull();
  });

  it('a wrong secret on a real prefix is argon2-checked every time and never remembered', async () => {
    const { service } = setup();
    const { plaintext } = await service.create(COMPANY, { name: 'crm' });
    await service.verify(plaintext); // the real key is now remembered
    argonVerify.mockClear();

    const [product, prefix] = plaintext.split('_');
    const wrong = `${product}_${prefix}_${'0'.repeat(64)}`;
    for (let i = 0; i < 3; i++) await expect(service.verify(wrong)).resolves.toBeNull();
    expect(argonVerify).toHaveBeenCalledTimes(3);

    // …and the real key is still answered from memory.
    await expect(service.verify(plaintext)).resolves.not.toBeNull();
    expect(argonVerify).toHaveBeenCalledTimes(3);
  });

  it('stamps last_used_at at most once a minute per key, not on every request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, lastUsedWrites } = setup();
    const a = await service.create(COMPANY, { name: 'a' });
    const b = await service.create(COMPANY, { name: 'b' });

    for (let i = 0; i < 10; i++) await service.verify(a.plaintext);
    await service.verify(b.plaintext);
    expect(lastUsedWrites).toEqual(['key-1', 'key-2']);

    vi.setSystemTime(Date.now() + 61_000);
    await service.verify(a.plaintext);
    expect(lastUsedWrites).toEqual(['key-1', 'key-2', 'key-1']);
  });
});
