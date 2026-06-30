import { Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import {
  Money,
  WHISH_CURRENCIES,
  WhishTransferStatus,
  type ListWhishTransfersQuery,
  type PaginatedResponse,
  type SendWhishTransferInput,
  type WhishTransferResponse,
} from '@app/shared';
import { Prisma } from '@app/db';
import type { WhishTransfer } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { ValidationError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { TransactionLogsService } from '../transaction-logs/transaction-logs.service';
import { WhishSessionStore } from './whish-session.store';
import { W2WCryptoError } from './w2w-crypto';
import { WhishW2WClient, WhishSessionExpiredError, type W2WSubmitResult } from './whish-w2w.client';

// One submit + at most one drift-corrected retry. The retry only ever fires on a
// clean `failed` (money did not move), so this can never double-send.
const MAX_TRANSFER_ATTEMPTS = 2;

/** Where a transfer originated — admin tool now, withdrawal auto-transfer later. */
export interface TransferOrigin {
  source: 'ADMIN' | 'WITHDRAWAL';
  actorId: string | null;
  companyId?: string | null;
  withdrawalId?: string | null;
}

/**
 * Sends outbound whish-to-whish transfers and records every attempt. The single
 * entry point `sendTransfer()` is used by the SUPER_ADMIN "Transfer Money" tool
 * now and is built to be called from `withdrawals.service.approve()` later (the
 * `origin` carries the actor + the withdrawal linkage / idempotency key).
 *
 * Whish gives us no transfer id and no idempotency key, so the safety model is
 * ours: a PENDING row is committed (unique on `reference` and `withdrawalId`)
 * BEFORE the upstream call, which makes a duplicate physically unable to reach a
 * second submit. A network/timeout leaves the row UNKNOWN (money may have moved)
 * for an operator to reconcile — never auto-retried.
 */
@Injectable()
export class WhishTransfersService {
  private readonly logger = new Logger(WhishTransfersService.name);
  // Serializes all sends in this process (admin tool + auto-poller) so the
  // sessionCounter lifecycle (reserve → submit → heal) of one transfer completes
  // before the next begins, preventing counter reuse under concurrency.
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: WhishW2WClient,
    private readonly session: WhishSessionStore,
    private readonly txLogs: TransactionLogsService,
  ) {}

  /** Whether W2W transfers are configured/enabled (env flag). */
  isW2WEnabled(): boolean {
    return this.client.isEnabled();
  }

  /** Non-secret session health (configured / lastRotatedAt / lastAuthFailureAt). */
  sessionStatus() {
    return this.session.status();
  }

  /** Public entry — serialized through `sendQueue` (see field) then runs executeSend. */
  async sendTransfer(
    input: SendWhishTransferInput,
    origin: TransferOrigin,
  ): Promise<WhishTransferResponse> {
    const result = this.sendQueue.then(
      () => this.executeSend(input, origin),
      () => this.executeSend(input, origin), // run even if the previous send rejected
    );
    // Keep the chain alive regardless of this send's outcome.
    this.sendQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeSend(
    input: SendWhishTransferInput,
    origin: TransferOrigin,
  ): Promise<WhishTransferResponse> {
    // 1. Validate. The typed amount is transferred as-is (no fee math).
    const money = Money.of(input.amount);
    if (!money.round().isPositive()) {
      throw new ValidationError('amount must be greater than zero');
    }
    if (!(WHISH_CURRENCIES as readonly string[]).includes(input.currency)) {
      throw new ValidationError(`currency must be one of ${WHISH_CURRENCIES.join(', ')}`);
    }
    if (!this.client.isEnabled()) {
      throw new ValidationError('Whish W2W transfers are not enabled (set WHISH_W2W_ENABLED=true)');
    }

    const reference = input.reference ?? `wt_${crypto.randomBytes(16).toString('base64url')}`;
    // Whish wants a bare msisdn; keep the operator-entered formatting minimal.
    const phone = input.recipientPhone.replace(/[\s-]/g, '').replace(/^\+/, '');
    const amount2dp = money.toFixed(2);
    const amountFull = money.toString();

    // 2. Idempotency pre-check (fast path; the unique index is the real guard).
    const existing = await this.prisma.runAsAdmin((tx) =>
      origin.withdrawalId
        ? tx.whishTransfer.findUnique({ where: { withdrawalId: origin.withdrawalId } })
        : tx.whishTransfer.findUnique({ where: { reference } }),
    );
    // A clean session-expired failure means the money did NOT move; once the session
    // is re-seeded the same withdrawal must be retryable. Reset that row and re-send
    // rather than returning a stale FAILED (which would wedge it as un-retryable).
    const resendable =
      existing?.status === WhishTransferStatus.FAILED && existing.errorDetail === 'session_expired';
    if (existing && !resendable) return this.map(existing);

    // 3. Obtain a PENDING row BEFORE calling Whish — reuse the resendable one, else
    //    create (a racing duplicate hits the unique constraint, P2002, → return it).
    let row: WhishTransfer;
    if (existing) {
      row = await this.prisma.runAsAdmin((tx) =>
        tx.whishTransfer.update({
          where: { id: existing.id },
          data: {
            status: WhishTransferStatus.PENDING,
            // Re-sync the destination fields: an operator may resend a session-expired
            // row with a corrected amount/phone (admin Transfer Money). The persisted
            // row must match what we actually submit to Whish, not the stale values —
            // otherwise the audit record diverges from the real transfer.
            recipientPhone: phone,
            amount: new Prisma.Decimal(amountFull),
            currency: input.currency,
            errorDetail: null,
            traceId: null,
            upstreamCode: null,
            upstreamMessage: null,
            responseBody: Prisma.DbNull,
          },
        }),
      );
    } else {
      try {
        row = await this.prisma.runAsAdmin((tx) =>
          tx.whishTransfer.create({
            data: {
              reference,
              recipientPhone: phone,
              amount: new Prisma.Decimal(amountFull),
              currency: input.currency,
              status: WhishTransferStatus.PENDING,
              actorId: origin.actorId,
              source: origin.source,
              companyId: origin.companyId ?? null,
              withdrawalId: origin.withdrawalId ?? null,
            },
          }),
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const dup = await this.prisma.runAsAdmin((tx) =>
            origin.withdrawalId
              ? tx.whishTransfer.findUnique({ where: { withdrawalId: origin.withdrawalId } })
              : tx.whishTransfer.findUnique({ where: { reference } }),
          );
          if (dup) return this.map(dup);
        }
        throw err;
      }
    }

    // 4. Acquire the session + the next monotonic counter.
    let session;
    try {
      session = await this.session.nextRequest();
    } catch (err) {
      if (err instanceof W2WCryptoError) {
        // Credential decryption failed (e.g. WHISH_W2W_ENC_KEY rotated) — submit was
        // NEVER reached, so money definitively did NOT move. Mark the row terminal and
        // surface a ValidationError so the auto-approval orchestrator reverts to manual
        // (its money-did-not-move branch) instead of treating it as an ambiguous
        // in-flight failure (UNKNOWN + needsReconcile + circuit-breaker burn).
        await this.fail(row.id, 'session_decrypt_failed', (err as Error).message, null);
        throw new ValidationError(
          'Whish W2W session credentials could not be decrypted — a SUPER_ADMIN must re-seed them (check WHISH_W2W_ENC_KEY).',
        );
      }
      throw err;
    }
    if (!session) {
      await this.fail(row.id, 'session_not_configured', null, null);
      throw new ValidationError(
        'Whish W2W session credentials are not configured. A SUPER_ADMIN must add them first.',
      );
    }
    await this.prisma.runAsAdmin((tx) =>
      tx.whishTransfer.update({
        where: { id: row.id },
        data: { sessionCounter: session.sessionCounter },
      }),
    );

    const redactedRequest = this.client.buildRedactedRequest({
      phone,
      amount: amount2dp,
    });

    // 5. Call Whish, self-healing the (possibly phone-shared) session counter.
    //    Whish echoes its expected next counter in the response header; we sync
    //    to it after every call. If that value is well ahead of what we sent —
    //    the signature of the phone advancing the session between our calls — we
    //    retry ONCE with the corrected counter. The retry is gated to a clean
    //    `failed` (money did NOT move), so it can never double-send.
    let activeSession = session;
    let result: W2WSubmitResult | undefined;
    for (let attempt = 1; attempt <= MAX_TRANSFER_ATTEMPTS; attempt++) {
      let r: W2WSubmitResult;
      try {
        r = await this.client.submit({
          phone,
          amount: amount2dp,
          session: activeSession,
        });
      } catch (err) {
        if (err instanceof WhishSessionExpiredError) {
          await this.session.markAuthFailure();
          await this.fail(row.id, 'session_expired', err.message, redactedRequest);
          this.txLogs.record({
            kind: 'WHISH_TRANSFER',
            reference,
            statusCode: 502,
            success: false,
            request: redactedRequest,
            response: { error: 'session_expired' },
          });
        }
        throw err;
      }
      result = r;
      const nextCounter = r.outcome === 'unreachable' ? null : r.nextCounter;

      // Sync our stored counter to Whish's authoritative next value.
      if (nextCounter != null) {
        await this.session.healCounter(nextCounter);
      }

      // Retry once on counter drift (Whish wants a counter > sent + 1).
      const counterDrift =
        r.outcome === 'failed' &&
        nextCounter != null &&
        nextCounter > activeSession.sessionCounter + 1;
      if (counterDrift && attempt < MAX_TRANSFER_ATTEMPTS) {
        const healed = await this.session.nextRequest();
        if (healed) {
          this.logger.warn(
            `Whish W2W ${reference}: counter drift (sent ${activeSession.sessionCounter}, ` +
              `Whish next ${nextCounter}) — retrying once with corrected counter`,
          );
          activeSession = healed;
          await this.prisma.runAsAdmin((tx) =>
            tx.whishTransfer.update({
              where: { id: row.id },
              data: { sessionCounter: healed.sessionCounter },
            }),
          );
          continue;
        }
      }
      break;
    }
    // The bounded loop always assigns `result` on its first iteration.
    if (!result) throw new ValidationError('Whish W2W transfer produced no result');

    if (result.outcome === 'unreachable') {
      // Money MAY have moved — never FAILED (would invite a dangerous resend).
      const updated = await this.prisma.runAsAdmin((tx) =>
        tx.whishTransfer.update({
          where: { id: row.id },
          data: {
            status: WhishTransferStatus.UNKNOWN,
            errorDetail: result.detail,
            requestBody: redactedRequest as Prisma.InputJsonValue,
            responseBody: { error: result.detail } as Prisma.InputJsonValue,
          },
        }),
      );
      this.txLogs.record({
        kind: 'WHISH_TRANSFER',
        reference,
        statusCode: 0,
        success: false,
        request: redactedRequest,
        response: { error: result.detail },
      });
      this.logger.warn(`Whish W2W transfer ${reference} is UNKNOWN: ${result.detail}`);
      return this.map(updated);
    }

    const success = result.outcome === 'success';
    const updated = await this.prisma.runAsAdmin((tx) =>
      tx.whishTransfer.update({
        where: { id: row.id },
        data: {
          status: success ? WhishTransferStatus.SUCCESS : WhishTransferStatus.FAILED,
          traceId: result.traceId,
          upstreamCode: result.code,
          upstreamMessage: result.message,
          errorDetail: success ? null : (result.message ?? result.code ?? 'transfer_failed'),
          requestBody: redactedRequest as Prisma.InputJsonValue,
          responseBody: (result.response ?? null) as Prisma.InputJsonValue,
        },
      }),
    );
    this.txLogs.record({
      kind: 'WHISH_TRANSFER',
      reference,
      transactionId: null,
      statusCode: result.httpStatus,
      success,
      request: redactedRequest,
      response: result.response,
    });
    return this.map(updated);
  }

  async listTransfers(
    query: ListWhishTransfersQuery,
  ): Promise<PaginatedResponse<WhishTransferResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.WhishTransferWhereInput = {};
      if (query.status) where.status = query.status;
      if (query.search) {
        where.OR = [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { recipientPhone: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
      const [rows, total] = await Promise.all([
        tx.whishTransfer.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: query.pageSize,
        }),
        tx.whishTransfer.count({ where }),
      ]);
      return {
        data: rows.map((r) => this.map(r)),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  async getById(id: string): Promise<WhishTransferResponse | null> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishTransfer.findUnique({ where: { id } }),
    );
    return row ? this.map(row) : null;
  }

  /** Mark a not-yet-sent (or session-rejected) row FAILED. Money did not move. */
  private async fail(
    id: string,
    detail: string,
    message: string | null,
    request: unknown,
  ): Promise<void> {
    await this.prisma.runAsAdmin((tx) =>
      tx.whishTransfer.update({
        where: { id },
        data: {
          status: WhishTransferStatus.FAILED,
          errorDetail: detail,
          upstreamMessage: message,
          requestBody: (request ?? null) as Prisma.InputJsonValue,
        },
      }),
    );
  }

  private map(r: WhishTransfer): WhishTransferResponse {
    return {
      id: r.id,
      reference: r.reference,
      recipientPhone: r.recipientPhone,
      amount: r.amount.toString(),
      currency: r.currency.trim(),
      status: r.status,
      traceId: r.traceId,
      upstreamMessage: r.upstreamMessage,
      errorDetail: r.errorDetail,
      source: r.source,
      withdrawalId: r.withdrawalId,
      companyId: r.companyId,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
