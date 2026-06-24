import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@app/db';
import type { UpdateWhishSessionInput, WhishSessionStatus } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { ValidationError } from '../../common/errors/domain.error';
import { decryptSecret, encryptSecret, loadW2WKey } from './w2w-crypto';

const ROW_ID = 'default';

/** The decrypted session material + the counter to use for ONE request. */
export interface ResolvedW2WSession {
  token: string;
  uid: string;
  sessionId: string;
  deviceId: string;
  serverId: string;
  itelVersion: string;
  osVersion: string;
  operatingSystem: string;
  userAgent: string;
  /** The counter consumed by this request (already incremented + persisted). */
  sessionCounter: number;
}

/**
 * Reads/writes the single captured Whish consumer-app session used to sign W2W
 * transfers, and hands out a fresh, monotonic `sessionCounter` per request.
 *
 * Secrets (token/uid/sessionid) are encrypted at rest with the env key; the
 * non-secret bits are stored plainly. `nextRequest()` does the counter bump as
 * an atomic `UPDATE … SET session_counter = session_counter + 1 RETURNING *`
 * (Prisma `increment`), so two concurrent transfers can never reuse a counter —
 * the row lock serialises them.
 */
@Injectable()
export class WhishSessionStore {
  private readonly logger = new Logger(WhishSessionStore.name);
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    const raw = this.config.get('WHISH_W2W_ENC_KEY', { infer: true });
    this.key = raw ? loadW2WKey(raw) : null;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ValidationError('Whish W2W is not configured (missing WHISH_W2W_ENC_KEY)');
    }
    return this.key;
  }

  /** Whether a session row exists (creds have been seeded at least once). */
  async isConfigured(): Promise<boolean> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishSessionCredential.findUnique({ where: { id: ROW_ID }, select: { id: true } }),
    );
    return !!row;
  }

  /**
   * Atomically consume the next counter and return the decrypted session for one
   * transfer. Returns null when no creds have been seeded yet.
   */
  async nextRequest(): Promise<ResolvedW2WSession | null> {
    const key = this.requireKey();
    let row;
    try {
      row = await this.prisma.runAsAdmin((tx) =>
        tx.whishSessionCredential.update({
          where: { id: ROW_ID },
          data: { sessionCounter: { increment: 1 } },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null; // no row yet
      }
      throw err;
    }
    return {
      token: decryptSecret(row.encToken, key),
      uid: decryptSecret(row.encUid, key),
      sessionId: decryptSecret(row.encSessionId, key),
      deviceId: row.deviceId,
      serverId: row.serverId,
      itelVersion: row.itelVersion,
      osVersion: row.osVersion,
      operatingSystem: row.operatingSystem,
      userAgent: row.userAgent,
      sessionCounter: row.sessionCounter,
    };
  }

  /** Replace the captured session (rotate creds, reseed the counter). */
  async updateCredentials(input: UpdateWhishSessionInput): Promise<WhishSessionStatus> {
    const key = this.requireKey();
    const data = {
      encToken: encryptSecret(input.token, key),
      encUid: encryptSecret(input.uid, key),
      encSessionId: encryptSecret(input.sessionId, key),
      deviceId: input.deviceId,
      serverId: input.serverId,
      itelVersion: input.itelVersion,
      osVersion: input.osVersion,
      operatingSystem: input.operatingSystem,
      userAgent: input.userAgent,
      sessionCounter: input.sessionCounter,
      lastRotatedAt: new Date(),
      // A fresh session clears the stale "expired" flag.
      lastAuthFailureAt: null,
    };
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishSessionCredential.upsert({
        where: { id: ROW_ID },
        create: { id: ROW_ID, ...data },
        update: data,
      }),
    );
    this.logger.log('Whish W2W session credentials rotated');
    return this.toStatus(row);
  }

  /** Flag that Whish just rejected the session as expired/invalid. */
  async markAuthFailure(): Promise<void> {
    await this.prisma
      .runAsAdmin((tx) =>
        tx.whishSessionCredential.update({
          where: { id: ROW_ID },
          data: { lastAuthFailureAt: new Date() },
        }),
      )
      .catch(() => {
        /* best-effort health flag; never mask the original error */
      });
  }

  /** Non-secret health/status for the admin panel. */
  async status(): Promise<WhishSessionStatus> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishSessionCredential.findUnique({ where: { id: ROW_ID } }),
    );
    if (!row) {
      return {
        configured: false,
        deviceId: null,
        serverId: null,
        itelVersion: null,
        sessionCounter: null,
        lastRotatedAt: null,
        lastAuthFailureAt: null,
      };
    }
    return this.toStatus(row);
  }

  private toStatus(row: {
    deviceId: string;
    serverId: string;
    itelVersion: string;
    sessionCounter: number;
    lastRotatedAt: Date | null;
    lastAuthFailureAt: Date | null;
  }): WhishSessionStatus {
    return {
      configured: true,
      deviceId: row.deviceId,
      serverId: row.serverId,
      itelVersion: row.itelVersion,
      sessionCounter: row.sessionCounter,
      lastRotatedAt: row.lastRotatedAt?.toISOString() ?? null,
      lastAuthFailureAt: row.lastAuthFailureAt?.toISOString() ?? null,
    };
  }
}
