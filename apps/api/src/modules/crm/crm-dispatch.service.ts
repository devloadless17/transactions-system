import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@app/db';
import type {
  CrmEventPayload,
  CrmEventTransaction,
  CrmEventWithdrawal,
  CrmTransactionEvent,
  CrmTransactionStatus,
  CrmWithdrawalEvent,
  CrmWithdrawalStatus,
  TransactionResponse,
  WithdrawalResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { CrmDeliveryService } from './crm-delivery.service';

const STATUS_FOR_TRANSACTION_EVENT: Record<CrmTransactionEvent, CrmTransactionStatus> = {
  'transaction.pending': 'PENDING',
  'transaction.completed': 'COMPLETED',
  'transaction.failed': 'FAILED',
  'transaction.expired': 'EXPIRED',
  'transaction.reversed': 'REVERSED',
};

const STATUS_FOR_WITHDRAWAL_EVENT: Record<CrmWithdrawalEvent, CrmWithdrawalStatus> = {
  'withdrawal.pending': 'PENDING',
  'withdrawal.completed': 'COMPLETED',
  'withdrawal.rejected': 'REJECTED',
  'withdrawal.cancelled': 'CANCELLED',
};

// How long a freshly-enqueued delivery is left to its first attempt before the
// retry sweep may take it. (The attempt's claim, not this, is what prevents a
// double POST — see CrmDeliveryService.claim.)
const DISPATCH_SWEEP_HEADSTART_MS = 60_000;
// Saving an event (its webhook_deliveries row) is retried on failure: until it
// is saved nothing can ever send it, so a database hiccup must not cost the
// company a status. 1s, 2s, 4s, 8s, 16s between the 6 attempts.
const SAVE_ATTEMPTS = 6;
const SAVE_RETRY_BASE_MS = 1_000;

/**
 * The single entry point other modules call to push a money event's status to a
 * company's CRM. Every method is fire-and-forget and fully guarded — a CRM
 * delivery must NEVER break the money path. We enqueue a durable
 * `webhook_deliveries` row (so an outage can't drop the event) and fire one
 * immediate best-effort attempt; the delivery service's sweep retries the rest.
 *
 * Two event families share this machinery:
 *   • transaction.* (deposits) — reference `${source}:${externalTransactionId}`.
 *   • withdrawal.*  (money out) — reference `withdrawal:${id}`.
 * Each reference is stable across its record's whole lifecycle, so the CRM
 * upserts one evolving row. Payouts and loads are deliberately NOT emitted.
 */
@Injectable()
export class CrmDispatchService {
  private readonly logger = new Logger(CrmDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: CrmDeliveryService,
  ) {}

  /** Emit from a fully-mapped transaction (ingest = completed, reverse = reversed). */
  emitFromTransaction(tr: TransactionResponse, event: CrmTransactionEvent): void {
    const transaction: CrmEventTransaction = {
      id: tr.id,
      status: STATUS_FOR_TRANSACTION_EVENT[event],
      source: tr.sourceCode,
      externalTransactionId: tr.externalTransactionId,
      amount: tr.amount,
      currency: tr.currency,
      netAmount: tr.netAmount,
      commissionAmount: tr.commissionAmount,
      networkFeeAmount: tr.networkFeeAmount,
      refunded: tr.refunded,
      refundedAt: tr.refundedAt,
      customer: tr.customer,
      tradingAccount: tr.target,
      phone: tr.phone,
      note: tr.note,
      occurredAt: tr.processedAt ?? tr.createdAt,
    };
    this.enqueue(tr.companyId, event, `${tr.sourceCode}:${tr.externalTransactionId}`, {
      transaction,
    });
  }

  /**
   * Emit a Whish payment lifecycle event (no ledger transaction exists yet for
   * PENDING/FAILED/EXPIRED). The COMPLETED step is emitted via
   * `emitFromTransaction` from the settlement ingest, with a matching reference.
   */
  emitWhish(input: {
    companyId: string;
    externalId: string | number | bigint;
    amount: string;
    currency: string;
    invoice?: string | null;
    payerPhoneNumber?: string | null;
    event: Extract<
      CrmTransactionEvent,
      'transaction.pending' | 'transaction.failed' | 'transaction.expired'
    >;
  }): void {
    const externalTransactionId = input.externalId.toString();
    const transaction: CrmEventTransaction = {
      id: null,
      status: STATUS_FOR_TRANSACTION_EVENT[input.event],
      source: 'whish',
      externalTransactionId,
      amount: input.amount,
      currency: input.currency.trim(),
      netAmount: null,
      commissionAmount: null,
      networkFeeAmount: null,
      refunded: false,
      refundedAt: null,
      customer: null,
      tradingAccount: null,
      phone: input.payerPhoneNumber ?? null,
      note: input.invoice ?? null,
      occurredAt: new Date().toISOString(),
    };
    this.enqueue(input.companyId, input.event, `whish:${externalTransactionId}`, { transaction });
  }

  /**
   * Emit a withdrawal lifecycle event (money out). The body mirrors the
   * withdrawal REST resource field-for-field (totalAmount / feeAmount /
   * networkFeeAmount / netAmount / payoutMethod / status), so a CRM sees the same shape over the
   * webhook as over GET /company/withdrawals/:id. Reference `withdrawal:<id>` is
   * stable PENDING → COMPLETED / REJECTED / CANCELLED, so the CRM upserts one
   * record. Payouts and loads are deliberately NOT emitted — API only.
   */
  emitWithdrawal(wr: WithdrawalResponse, event: CrmWithdrawalEvent): void {
    const withdrawal: CrmEventWithdrawal = {
      id: wr.id,
      status: STATUS_FOR_WITHDRAWAL_EVENT[event],
      amount: wr.amount,
      totalAmount: wr.totalAmount,
      feeAmount: wr.feeAmount,
      networkFeeAmount: wr.networkFeeAmount,
      netAmount: wr.netAmount,
      feeApplication: wr.feeApplication,
      currency: wr.currency,
      payoutMethod: wr.payoutMethod,
      payoutDetails: wr.payoutDetails,
      note: wr.notes,
      adminNote: wr.adminNotes,
      externalReference: wr.externalReference,
      createdAt: wr.createdAt,
      processedAt: wr.processedAt,
      occurredAt: wr.processedAt ?? wr.createdAt,
    };
    this.enqueue(wr.companyId, event, `withdrawal:${wr.id}`, { withdrawal });
  }

  private enqueue(
    companyId: string,
    event: CrmEventPayload['event'],
    reference: string,
    body: Pick<CrmEventPayload, 'transaction' | 'withdrawal'>,
  ): void {
    // Stamped HERE, synchronously, at the moment the event is emitted — not
    // later inside the async run(). `sentAt` is what a CRM orders one
    // reference's events by (deliveries are at-least-once and unordered), so it
    // must follow the order the events actually happened in, whatever order
    // their database round trips below happen to finish in.
    const sentAt = new Date().toISOString();
    void this.save(companyId, event, reference, body, sentAt);
  }

  /** `run`, retried until the event is saved (see SAVE_ATTEMPTS). Never throws. */
  private async save(
    companyId: string,
    event: CrmEventPayload['event'],
    reference: string,
    body: Pick<CrmEventPayload, 'transaction' | 'withdrawal'>,
    sentAt: string,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.run(companyId, event, reference, body, sentAt);
        return;
      } catch (err) {
        if (attempt >= SAVE_ATTEMPTS) {
          this.logger.error(
            `CRM ${event} for ${reference} could not be saved after ${attempt} attempts — ` +
              `company ${companyId} was NOT told: ${(err as Error).message}`,
          );
          return;
        }
        this.logger.warn(
          `CRM dispatch for ${reference} failed (attempt ${attempt}/${SAVE_ATTEMPTS}), retrying: ` +
            (err as Error).message,
        );
        await new Promise((r) => setTimeout(r, SAVE_RETRY_BASE_MS * 2 ** (attempt - 1)));
      }
    }
  }

  private async run(
    companyId: string,
    event: CrmEventPayload['event'],
    reference: string,
    body: Pick<CrmEventPayload, 'transaction' | 'withdrawal'>,
    sentAt: string,
  ): Promise<void> {
    const payload: CrmEventPayload = { event, reference, sentAt, ...body };
    const firstAttemptAt = new Date(Date.now() + DISPATCH_SWEEP_HEADSTART_MS);
    // One transaction: read the company's CRM settings and save the event.
    const row = await this.prisma.runAsAdmin(async (tx) => {
      const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { crmEnabled: true, crmApiUrl: true },
      });
      if (!company?.crmEnabled || !company.crmApiUrl) return null;
      return tx.webhookDelivery.create({
        data: {
          companyId,
          eventType: event,
          payload: payload as unknown as Prisma.InputJsonValue,
          targetUrl: company.crmApiUrl,
          status: 'PENDING',
          // Left to its first attempt (below) until then; if the process dies
          // right after insert, the sweep still picks it up.
          nextRetryAt: firstAttemptAt,
        },
        select: { id: true },
      });
    });
    if (!row) return;
    // First attempt as soon as a lane is free (fair across companies, bounded);
    // the sweep retries on failure. deliverSoon never throws: an attempt that
    // fails early leaves the row queued for the sweep.
    this.delivery.deliverSoon(row.id, companyId, firstAttemptAt);
  }
}
