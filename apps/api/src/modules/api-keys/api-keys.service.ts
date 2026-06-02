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

type Owner = { kind: 'company'; companyId: string } | { kind: 'source'; sourceId: string };

@Injectable()
export class ApiKeysService {
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
   * Look up by the 8-char prefix to narrow the candidate set, then argon2-verify
   * each candidate. There's a finite set (~1-10) per prefix, so this is fast.
   * Updates last_used_at on hit (best effort).
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

    for (const c of candidates) {
      const ok = await argon2.verify(c.keyHash, plaintext).catch(() => false);
      if (ok) {
        this.prisma
          .runAsAdmin((tx) =>
            tx.apiKey.update({ where: { id: c.id }, data: { lastUsedAt: new Date() } }),
          )
          .catch(() => undefined);
        return { companyId: c.companyId, sourceId: c.sourceId, keyId: c.id };
      }
    }
    return null;
  }
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
