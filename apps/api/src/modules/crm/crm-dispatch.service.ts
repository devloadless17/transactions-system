import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@app/db';
import {
  PayoutMethod,
  type CrmEventPayload,
  type CrmEventTransaction,
  type CrmEventWithdrawal,
  type CrmTransactionEvent,
  type CrmTransactionStatus,
  type CrmWithdrawalEvent,
  type CrmWithdrawalStatus,
  type PayoutDetails,
  type TransactionResponse,
  type WithdrawalResponse,
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

// How long a freshly-enqueued delivery is withheld from the retry sweep so the
// inline immediate attempt (≤5s) can finish first and we don't double-POST.
const DISPATCH_SWEEP_HEADSTART_MS = 60_000;

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
   * netAmount / payoutMethod / status), so a CRM sees the same shape over the
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
      netAmount: wr.netAmount,
      feeApplication: wr.feeApplication,
      currency: wr.currency,
      payoutMethod: wr.payoutMethod,
      recipient: recipientLabel(wr.payoutDetails),
      recipientPhone: recipientPhoneOf(wr.payoutDetails),
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
    void this.run(companyId, event, reference, body).catch((err) =>
      this.logger.warn(`CRM dispatch for ${reference} failed: ${(err as Error).message}`),
    );
  }

  private async run(
    companyId: string,
    event: CrmEventPayload['event'],
    reference: string,
    body: Pick<CrmEventPayload, 'transaction' | 'withdrawal'>,
  ): Promise<void> {
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { crmEnabled: true, crmApiUrl: true },
      }),
    );
    if (!company?.crmEnabled || !company.crmApiUrl) return;

    const payload: CrmEventPayload = {
      event,
      reference,
      sentAt: new Date().toISOString(),
      ...body,
    };
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.webhookDelivery.create({
        data: {
          companyId,
          eventType: event,
          payload: payload as unknown as Prisma.InputJsonValue,
          targetUrl: company.crmApiUrl!,
          status: 'PENDING',
          // Hold the row back from the retry sweep briefly so the immediate
          // attempt below (≤5s) gets a clear head start — otherwise a sweep tick
          // landing while it's still in flight would POST the same event twice.
          // If the process dies right after insert, the sweep still picks it up.
          nextRetryAt: new Date(Date.now() + DISPATCH_SWEEP_HEADSTART_MS),
        },
        select: { id: true },
      }),
    );
    // Immediate best-effort attempt; the sweep retries on failure. Guard the
    // detached promise so an early throw inside deliver() (e.g. its first DB read,
    // before deliver()'s own try/catch) can't surface as an unhandled rejection —
    // the row is already queued, so the retry sweep picks it up regardless.
    void this.delivery
      .deliver(row.id)
      .catch((err) =>
        this.logger.warn(
          `CRM immediate deliver ${row.id} failed (sweep will retry): ${(err as Error).message}`,
        ),
      );
  }
}

/**
 * A human label for a withdrawal's destination, by method: the recipient name
 * (cash/wish), the account holder (bank), the wallet address (crypto), or the
 * free-text description (other). Null when the row has no payout details.
 */
function recipientLabel(details: PayoutDetails | null): string | null {
  if (!details) return null;
  switch (details.method) {
    case PayoutMethod.CASH:
    case PayoutMethod.WISH:
      return details.recipientName;
    case PayoutMethod.BANK_TRANSFER:
      return details.accountHolder;
    case PayoutMethod.CRYPTO:
      return details.walletAddress;
    case PayoutMethod.OTHER:
      return details.description;
    default:
      return null;
  }
}

/**
 * The recipient's phone number, for the payout methods that carry one (cash /
 * Whish — where the phone IS the destination). Null for methods without a phone
 * (crypto / bank / other).
 */
function recipientPhoneOf(details: PayoutDetails | null): string | null {
  if (!details) return null;
  switch (details.method) {
    case PayoutMethod.CASH:
    case PayoutMethod.WISH:
      return details.recipientPhone;
    default:
      return null;
  }
}
