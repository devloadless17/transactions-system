import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import {
  Money,
  type CreateWhishPaymentInput,
  type ListWhishPaymentsQuery,
  type PaginatedResponse,
  type SupportedCurrency,
  type WhishClientConfig,
  type WhishPaymentResponse,
  WhishPaymentStatus,
} from '@app/shared';
import type { Prisma, WhishPayment } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { TransactionsService } from '../transactions/transactions.service';
import { CommissionResolverService } from '../commissions/commission-resolver.service';
import { CommissionsRepository } from '../commissions/commissions.repository';
import { WhishClient, WhishError } from './whish.client';
import { WhishWebhookService } from './whish-webhook.service';
import { RealtimeService } from '../realtime/realtime.service';

const WHISH_SOURCE_CODE = 'whish';
// Stale-payment reconciliation window.
const RECONCILE_MIN_AGE_MS = 60_000; // don't poll links younger than this
const EXPIRE_AGE_MS = 24 * 3600_000; // give up (EXPIRED) after this

@Injectable()
export class WhishPaymentsService {
  private readonly logger = new Logger(WhishPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whish: WhishClient,
    private readonly config: ConfigService<Env, true>,
    private readonly transactions: TransactionsService,
    private readonly webhooks: WhishWebhookService,
    private readonly commissionResolver: CommissionResolverService,
    private readonly commissionsRepo: CommissionsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /** Currencies live for Whish links (USD only by default). */
  enabledCurrencies(): string[] {
    return this.config.get('WHISH_ENABLED_CURRENCIES', { infer: true });
  }

  clientConfig(): WhishClientConfig {
    return { enabledCurrencies: this.enabledCurrencies() };
  }

  /**
   * Mint a Whish payment link for a company.
   *   1. Insert a PENDING whish_payments row → DB assigns the numeric externalId
   *   2. Build callback + redirect URLs carrying externalId + an unguessable token
   *   3. Call Whish POST /payment/whish → collectUrl
   *   4. Store collectUrl and return. On Whish failure, mark the row FAILED.
   */
  async createPayment(
    companyId: string,
    input: CreateWhishPaymentInput,
  ): Promise<WhishPaymentResponse> {
    // 1. Currency must be live (USD only by default; LBP behind a flag).
    if (!this.enabledCurrencies().includes(input.currency)) {
      throw new ValidationError(
        `Whish payments in ${input.currency} are not enabled. Enabled: ${this.enabledCurrencies().join(', ') || 'none'}.`,
      );
    }

    // 2. Commission must resolve up front — never mint a link that can't
    //    settle. (Without this, a paid payment with no matching rule would be
    //    stuck PENDING forever.) This is also what makes enabling LBP safe:
    //    if no LBP rule covers the amount, creation fails clearly here instead
    //    of after the customer has paid.
    const source = await this.resolveWhishSource();
    await this.assertCommissionResolves(companyId, source.id, input.amount);

    // Idempotency: a retried create with the same key returns the original.
    if (input.idempotencyKey) {
      const prior = await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.findFirst({ where: { companyId, idempotencyKey: input.idempotencyKey } }),
      );
      if (prior) return mapWhishPayment(prior);
    }

    const callbackToken = crypto.randomBytes(24).toString('base64url');

    const created = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.whishPayment.create({
        data: {
          companyId,
          callbackToken,
          amount: input.amount,
          currency: input.currency,
          invoice: input.invoice,
          idempotencyKey: input.idempotencyKey ?? null,
          status: WhishPaymentStatus.PENDING,
        },
      }),
    );

    const externalId = Number(created.externalId);
    const apiBase = this.config.get('WHISH_CALLBACK_BASE', { infer: true });
    const webBase = this.config.get('WEB_ORIGIN', { infer: true });
    const q = `token=${callbackToken}&externalId=${externalId}`;

    try {
      const { collectUrl } = await this.whish.postPayment({
        amount: input.amount,
        currency: input.currency,
        invoice: input.invoice,
        externalId,
        successCallbackUrl: `${apiBase}/whish/callback/success?${q}`,
        failureCallbackUrl: `${apiBase}/whish/callback/failure?${q}`,
        successRedirectUrl: `${webBase}/pay/success?ref=${externalId}`,
        failureRedirectUrl: `${webBase}/pay/failure?ref=${externalId}`,
      });

      const updated = await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.update({ where: { id: created.id }, data: { collectUrl } }),
      );
      this.logger.log(
        `Whish link created: company=${companyId} externalId=${externalId} amount=${input.amount} ${input.currency}`,
      );
      this.realtime.company(companyId, ['whish']);
      return mapWhishPayment(updated);
    } catch (err) {
      await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.update({
          where: { id: created.id },
          data: {
            status: WhishPaymentStatus.FAILED,
            metadata: { error: err instanceof Error ? err.message : 'unknown' },
          },
        }),
      );
      this.realtime.company(companyId, ['whish']);
      throw err;
    }
  }

  async list(
    companyId: string,
    query: ListWhishPaymentsQuery,
  ): Promise<PaginatedResponse<WhishPaymentResponse>> {
    return this.prisma.runAsTenant(companyId, async (tx) => {
      const where: Prisma.WhishPaymentWhereInput = { companyId };
      if (query.status) where.status = query.status;
      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.whishPayment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
        }),
        tx.whishPayment.count({ where }),
      ]);
      return {
        data: rows.map(mapWhishPayment),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  async getById(companyId: string, id: string): Promise<WhishPaymentResponse> {
    const row = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.whishPayment.findFirst({ where: { id, companyId } }),
    );
    if (!row) throw new NotFoundError('WhishPayment', id);
    return mapWhishPayment(row);
  }

  /**
   * Handle a Whish callback (public, unauthenticated GET). We DON'T trust the
   * callback: we look the payment up by externalId, check the unguessable
   * token matches, then verify the real status with Whish before settling.
   * Always resolves (returns void) so the callback endpoint can reply 200.
   */
  async handleCallback(externalId: number, token: string): Promise<void> {
    const payment = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUnique({ where: { externalId: BigInt(externalId) } }),
    );
    if (!payment) {
      this.logger.warn(`Whish callback for unknown externalId=${externalId}`);
      return;
    }
    if (payment.callbackToken !== token) {
      this.logger.warn(`Whish callback token mismatch for externalId=${externalId}`);
      return;
    }
    try {
      await this.reconcile(payment);
    } catch (err) {
      // Swallow — Whish only needs a 200; reconciliation can be retried.
      this.logger.error(`Whish callback reconcile failed externalId=${externalId}`, err as Error);
    }
  }

  /** Company-initiated reconcile (manual "refresh status" for missed callbacks). */
  async refreshStatus(companyId: string, id: string): Promise<WhishPaymentResponse> {
    const payment = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.whishPayment.findFirst({ where: { id, companyId } }),
    );
    if (!payment) throw new NotFoundError('WhishPayment', id);
    if (payment.companyId !== companyId) throw new ForbiddenError();
    return this.reconcile(payment);
  }

  /** Look up a payment by its numeric reference (externalId) — used by the CRM integration. */
  async getByExternalId(companyId: string, externalId: number): Promise<WhishPaymentResponse> {
    const row = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.whishPayment.findFirst({ where: { externalId: BigInt(externalId), companyId } }),
    );
    if (!row) throw new NotFoundError('WhishPayment', String(externalId));
    return mapWhishPayment(row);
  }

  /** Reconcile a payment by its numeric reference (externalId). */
  async refreshByExternalId(companyId: string, externalId: number): Promise<WhishPaymentResponse> {
    const payment = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.whishPayment.findFirst({ where: { externalId: BigInt(externalId), companyId } }),
    );
    if (!payment) throw new NotFoundError('WhishPayment', String(externalId));
    return this.reconcile(payment);
  }

  /**
   * Authoritative settlement: ask Whish for the real collect status and act on
   * it. Idempotent — a PAID payment is left alone, and settlement re-uses the
   * existing ingest path whose (source, externalId) unique constraint prevents
   * a double credit if this runs twice.
   */
  private async reconcile(payment: WhishPayment): Promise<WhishPaymentResponse> {
    if (payment.status === WhishPaymentStatus.PAID) return mapWhishPayment(payment);

    const currency = payment.currency.trim();
    const { collectStatus, payerPhoneNumber } = await this.whish.getStatus({
      currency,
      externalId: Number(payment.externalId),
    });

    if (collectStatus === 'pending') {
      return mapWhishPayment(payment);
    }

    if (collectStatus === 'failed') {
      const updated = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.update({
          where: { id: payment.id },
          data: { status: WhishPaymentStatus.FAILED, payerPhoneNumber },
        }),
      );
      this.logger.log(`Whish payment ${payment.externalId} FAILED`);
      this.realtime.company(payment.companyId, ['whish']);
      return mapWhishPayment(updated);
    }

    // success → write a ledger Transaction via the existing ingest pipeline
    // (commission + ledger + wallet credit), then mark PAID.
    const source = await this.resolveWhishSource();
    const txn = await this.transactions.ingest(
      { kind: 'source', sourceId: source.id },
      {
        companyId: payment.companyId,
        externalTransactionId: String(payment.externalId),
        amount: payment.amount.toString(),
        currency: currency as SupportedCurrency,
        payload: {
          whish: {
            externalId: payment.externalId.toString(),
            invoice: payment.invoice,
            payerPhoneNumber,
          },
        },
      },
    );

    const updated = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: payment.id },
        data: {
          status: WhishPaymentStatus.PAID,
          transactionId: txn.id,
          payerPhoneNumber,
          paidAt: new Date(),
        },
      }),
    );
    this.logger.log(
      `Whish payment ${payment.externalId} PAID → transaction ${txn.id} (company ${payment.companyId})`,
    );
    // Notify the company's webhook (best-effort, never blocks settlement).
    void this.webhooks.deliverPaid(updated);
    // `transactions.ingest` already announced transactions/wallets/ledger;
    // this refreshes the Whish payment views.
    this.realtime.company(payment.companyId, ['whish']);
    return mapWhishPayment(updated);
  }

  /**
   * Background reconciliation: pull status for stale PENDING payments (a
   * callback may have been missed), and give up on very old ones (EXPIRED).
   * No-op when Whish isn't configured. Returns a small summary for logging.
   */
  async reconcileStalePayments(): Promise<{ checked: number; expired: number }> {
    if (!this.whish.isConfigured()) return { checked: 0, expired: 0 };

    const now = Date.now();
    const youngerThan = new Date(now - RECONCILE_MIN_AGE_MS);
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findMany({
        where: { status: WhishPaymentStatus.PENDING, createdAt: { lt: youngerThan } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    );

    let expired = 0;
    for (const p of rows) {
      if (now - p.createdAt.getTime() > EXPIRE_AGE_MS) {
        await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.update({
            where: { id: p.id },
            data: { status: WhishPaymentStatus.EXPIRED },
          }),
        );
        this.realtime.company(p.companyId, ['whish']);
        expired++;
        continue;
      }
      try {
        await this.reconcile(p);
      } catch (err) {
        this.logger.warn(`Reconcile failed for payment ${p.externalId}: ${(err as Error).message}`);
      }
    }
    return { checked: rows.length, expired };
  }

  /** Admin: list Whish payments across all companies. */
  async listAll(query: {
    page: number;
    pageSize: number;
    status?: WhishPaymentResponse['status'];
  }): Promise<PaginatedResponse<WhishPaymentResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where = query.status ? { status: query.status } : {};
      const skip = (query.page - 1) * query.pageSize;
      const [rows, total] = await Promise.all([
        tx.whishPayment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
        }),
        tx.whishPayment.count({ where }),
      ]);
      return {
        data: rows.map(mapWhishPayment),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  private async resolveWhishSource(): Promise<{ id: string }> {
    const source = await this.prisma.runAsAdmin((tx) =>
      tx.source.findUnique({ where: { code: WHISH_SOURCE_CODE } }),
    );
    if (!source) throw new WhishError(`Source '${WHISH_SOURCE_CODE}' is not provisioned`);
    return source;
  }

  /**
   * Dry-run the commission resolver so we never mint a link that can't settle.
   * Throws NoMatchingCommissionRuleError (422) if no rule covers the amount —
   * surfaced at create time, before the customer pays.
   */
  private async assertCommissionResolves(
    companyId: string,
    sourceId: string,
    amount: string,
  ): Promise<void> {
    const rules = await this.prisma.runAsAdmin((tx) =>
      this.commissionsRepo.loadCandidates(tx, {
        companyId,
        sourceId,
        operationType: 'TRANSACTION',
      }),
    );
    // Throws if nothing matches; we only care about the throw, not the result.
    this.commissionResolver.resolve({
      companyId,
      sourceId,
      operationType: 'TRANSACTION',
      amount: Money.of(amount),
      rules,
    });
  }

  /** Platform Whish account balance (admin). */
  async getBalance(currency: 'USD'): Promise<{ currency: string; balance: number }> {
    const { balance } = await this.whish.getBalance(currency);
    return { currency, balance };
  }
}

function mapWhishPayment(row: WhishPayment): WhishPaymentResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    externalId: row.externalId.toString(),
    status: row.status,
    amount: row.amount.toString(),
    currency: row.currency.trim(),
    invoice: row.invoice,
    collectUrl: row.collectUrl,
    payerPhoneNumber: row.payerPhoneNumber,
    transactionId: row.transactionId,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}
