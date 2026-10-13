import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import type { ApiKeyResponse, CreateApiKeyInput, CreateApiKeyResponse } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotFoundError } from '../../common/errors/domain.error';

// All plaintext API keys are formatted as: tsk_<prefix>_<random>
// - tsk = "transaction system key" — easy to grep in logs and revoke
// - prefix is the first 8 chars after `tsk_`, also stored in DB for fast lookup
// - the remainder is the secret, hashed via argon2id
const KEY_PRODUCT = 'tsk';

// argon2 is deliberately slow — tens of milliseconds and 64 MB per check, on
// Node's 4-thread pool — so running it on EVERY request capped one integration
// at ~40 requests a second, and a burst queued the pool's other work (DNS
// lookups for calls to Whish) behind it. A key that verified once is remembered
// by this process, so its later requests skip argon2. Safe by construction:
//   - only a pure function is memoized: argon2.verify's answer for this exact
//     stored hash and this exact key never changes;
//   - revocation, rotation and expiry are still decided by the live candidate
//     query on every request, so a revoked key stops working at once, on every
//     instance;
//   - only successes are remembered (a wrong key is never answered from memory
//     and cannot grow the memo), and never the key itself — only its sha256,
//     compared in constant time.
const VERIFIED_MEMO_MAX = 10_000;
// last_used_at is for people ("Last used" in the dashboard): stamped at most
// once a minute per key, not one row write per request in a burst.
const LAST_USED_EVERY_MS = 60_000;

type Owner = { kind: 'company'; companyId: string } | { kind: 'source'; sourceId: string };

@Injectable()
export class ApiKeysService {
  /** Stored argon2 hash → sha256 of the key that verified against it. */
  private readonly verified = new Map<string, Buffer>();
  /** argon2 checks running now, by stored hash + key digest — shared, not repeated. */
  private readonly inflight = new Map<string, Promise<boolean>>();
  /** Key id → when this process last stamped its last_used_at. */
  private readonly lastUsedStamped = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Company keys live in a company view; source keys under the admin sources view. */
  private notify(owner: Owner) {
    if (owner.kind === 'company') this.realtime.company(owner.companyId, ['api-keys']);
    else this.realtime.admin(['sources']);
  }

  async create(owner: Owner, input: CreateApiKeyInput): Promise<CreateApiKeyResponse> {
    const plaintext = generateKey();
    const { prefix } = parseKey(plaintext)!;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });

    const row = await this.prisma.runAsAdmin((tx) =>
      tx.apiKey.create({
        data: {
          companyId: owner.kind === 'company' ? owner.companyId : null,
          sourceId: owner.kind === 'source' ? owner.sourceId : null,
          name: input.name,
          keyPrefix: prefix,
          keyHash: hash,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      }),
    );

    this.notify(owner);
    return { apiKey: mapKey(row), plaintext };
  }

  async listByCompany(companyId: string): Promise<ApiKeyResponse[]> {
    const rows = await this.prisma.runAsScoped(companyId, (tx) =>
      tx.apiKey.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(mapKey);
  }

  async listBySource(sourceId: string): Promise<ApiKeyResponse[]> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.apiKey.findMany({ where: { sourceId }, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map(mapKey);
  }

  async revoke(owner: Owner, id: string): Promise<ApiKeyResponse> {
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const k = await tx.apiKey.findUnique({ where: { id } });
      if (!k) throw new NotFoundError('ApiKey', id);
      const matches =
        (owner.kind === 'company' && k.companyId === owner.companyId) ||
        (owner.kind === 'source' && k.sourceId === owner.sourceId);
      if (!matches) throw new NotFoundError('ApiKey', id);
      if (k.revokedAt) return k;
      return tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    });
    this.notify(owner);
    return mapKey(row);
  }

  /**
   * Rotate a key: mint a fresh key that inherits the old key's name + expiry,
   * and revoke the old one — atomically, returning the new plaintext (shown
   * once). For a zero-downtime swap, deploy the new key, then rotate: the old
   * key keeps working until this call revokes it.
   *
   * The `(company_id, name)` unique index means we can't have two live keys
   * with the same name, so the old key is renamed (its id appended) as it's
   * revoked — freeing the original name for the new key.
   */
  async rotate(owner: Owner, id: string): Promise<CreateApiKeyResponse> {
    const plaintext = generateKey();
    const { prefix } = parseKey(plaintext)!;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });

    const row = await this.prisma.runAsAdmin(async (tx) => {
      const old = await tx.apiKey.findUnique({ where: { id } });
      if (!old) throw new NotFoundError('ApiKey', id);
      const matches =
        (owner.kind === 'company' && old.companyId === owner.companyId) ||
        (owner.kind === 'source' && old.sourceId === owner.sourceId);
      if (!matches) throw new NotFoundError('ApiKey', id);

      // Free the original name (unique per company) before reusing it.
      await tx.apiKey.update({
        where: { id },
        data: {
          name: `${old.name} (rotated:${old.id.slice(0, 8)})`,
          revokedAt: old.revokedAt ?? new Date(),
        },
      });
      return tx.apiKey.create({
        data: {
          companyId: old.companyId,
          sourceId: old.sourceId,
          name: old.name,
          keyPrefix: prefix,
          keyHash: hash,
          expiresAt: old.expiresAt,
        },
      });
    });

    this.notify(owner);
    return { apiKey: mapKey(row), plaintext };
  }

  /**
   * Look up by the 8-char prefix to narrow the candidate set, then verify each
   * candidate (argon2, or the memo of an earlier success — see
   * VERIFIED_MEMO_MAX). Updates last_used_at on hit (best effort, at most once
   * a minute per key).
   *
   * Returns the owner — either a companyId or a sourceId — so callers can
   * dispatch on the key flavour.
   */
  async verify(
    plaintext: string,
  ): Promise<{ companyId: string | null; sourceId: string | null; keyId: string } | null> {
    const parsed = parseKey(plaintext);
    if (!parsed) return null;
    const { prefix } = parsed;

    const candidates = await this.prisma.runAsAdmin((tx) =>
      tx.apiKey.findMany({
        where: {
          keyPrefix: prefix,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      }),
    );

    const digest = crypto.createHash('sha256').update(plaintext).digest();
    for (const c of candidates) {
      if (!(await this.matches(c.keyHash, plaintext, digest))) continue;
      this.stampLastUsed(c.id);
      return { companyId: c.companyId, sourceId: c.sourceId, keyId: c.id };
    }
    return null;
  }

  private async matches(keyHash: string, plaintext: string, digest: Buffer): Promise<boolean> {
    const known = this.verified.get(keyHash);
    if (known && crypto.timingSafeEqual(known, digest)) return true;
    // Requests with the same key that arrive together (a burst right after a
    // restart, before anything is remembered) share one argon2 check instead
    // of queueing one each on the thread pool.
    const flightKey = `${keyHash}:${digest.toString('hex')}`;
    let flight = this.inflight.get(flightKey);
    if (!flight) {
      flight = argon2
        .verify(keyHash, plaintext)
        .catch(() => false)
        .then((ok) => {
          if (ok) setCapped(this.verified, keyHash, digest);
          return ok;
        })
        .finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, flight);
    }
    return flight;
  }

  private stampLastUsed(keyId: string): void {
    const now = Date.now();
    const last = this.lastUsedStamped.get(keyId);
    if (last !== undefined && now - last < LAST_USED_EVERY_MS) return;
    setCapped(this.lastUsedStamped, keyId, now);
    this.prisma
      .runAsAdmin((tx) =>
        tx.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(now) } }),
      )
      .catch(() => undefined);
  }
}

/** Set, first dropping the oldest entry once the map is full (Maps keep insertion order). */
function setCapped<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= VERIFIED_MEMO_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function generateKey(): string {
  // 8-char prefix from base32-style alphabet (no ambiguous chars).
  const PREFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let prefix = '';
  const prefixBytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    prefix += PREFIX_ALPHABET[prefixBytes[i]! % PREFIX_ALPHABET.length];
  }
  // hex avoids the `_` / `-` chars from base64url that would collide with the
  // `tsk_<prefix>_<secret>` delimiter used by parseKey.
  const secret = crypto.randomBytes(32).toString('hex');
  return `${KEY_PRODUCT}_${prefix}_${secret}`;
}

function parseKey(key: string): { prefix: string } | null {
  const parts = key.split('_');
  if (parts.length !== 3) return null;
  if (parts[0] !== KEY_PRODUCT) return null;
  const prefix = parts[1];
  const secret = parts[2];
  if (!prefix || prefix.length !== 8) return null;
  if (!secret || secret.length < 16) return null;
  return { prefix };
}

function mapKey(row: {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ApiKeyResponse {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
