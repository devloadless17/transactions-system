import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import {
  Money,
  SourceFeeChannel,
  WHISH_CURRENCIES,
  type CreateWhishPaymentInput,
  type ListWhishPaymentsQuery,
  type PaginatedResponse,
  type SetWhishRedirectConfigInput,
  type SupportedCurrency,
  type WhishClientConfig,
  type WhishPaymentResponse,
  type WhishRedirectConfig,
  WhishPaymentStatus,
} from '@app/shared';
import { Prisma } from '@app/db';
import type { WhishPayment } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import {
  DuplicateTransactionError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { TransactionsService } from '../transactions/transactions.service';
import { CommissionResolverService } from '../commissions/commission-resolver.service';
import { CommissionsRepository } from '../commissions/commissions.repository';
import { WhishClient, WhishError } from './whish.client';
import { WhishWebhookService } from './whish-webhook.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CrmDispatchService } from '../crm/crm-dispatch.service';
import { TransactionLogsService } from '../transaction-logs/transaction-logs.service';

const WHISH_SOURCE_CODE = 'whish';
// Stale-payment reconciliation window.
const RECONCILE_MIN_AGE_MS = 60_000; // don't poll links younger than this
const EXPIRE_AGE_MS = 24 * 3600_000; // give up (EXPIRED) after this
// Max stale-pending links polled per reconciliation tick. Whish never pushes a
// failure (only a success callback), so polling is the ONLY way failed/abandoned
// links reach the CRM live. A small cap let a backlog of still-pending links
// starve newer ones (oldest-first), so a genuinely-failed payment could wait
// until a manual refresh. This drains the whole stale-pending set each tick;
// the cap is just a safety bound on Whish API calls per minute.
const RECONCILE_MAX_PER_TICK = 250;

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
    private readonly crm: CrmDispatchService,
    private readonly txLogs: TransactionLogsService,
  ) {}

  /**
   * Currencies live for Whish links (USD only by default). Intersected with
   * WHISH_CURRENCIES — the set `createWhishPaymentSchema` actually accepts — so a
   * misconfigured env can never advertise a currency in the UI/clientConfig that
   * every create call would then reject at validation.
   */
  enabledCurrencies(): string[] {
    const configured = this.config.get('WHISH_ENABLED_CURRENCIES', { infer: true });
    return configured.filter((c) => (WHISH_CURRENCIES as readonly string[]).includes(c));
  }

  clientConfig(): WhishClientConfig {
    return { enabledCurrencies: this.enabledCurrencies() };
  }

  /** A company's saved default redirect URLs (null = platform /pay pages). */
  async getRedirectConfig(companyId: string): Promise<WhishRedirectConfig> {
    const c = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { whishSuccessRedirectUrl: true, whishFailureRedirectUrl: true },
      }),
    );
    return {
      successUrl: c?.whishSuccessRedirectUrl ?? null,
      failureUrl: c?.whishFailureRedirectUrl ?? null,
    };
  }

  /** Save (or clear, with nulls) a company's default Whish redirect URLs. */
  async setRedirectConfig(
    companyId: string,
    input: SetWhishRedirectConfigInput,
  ): Promise<WhishRedirectConfig> {
    await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: {
          whishSuccessRedirectUrl: input.successUrl,
          whishFailureRedirectUrl: input.failureUrl,
        },
      }),
    );
    this.realtime.company(companyId, ['whish']);
    return { successUrl: input.successUrl, failureUrl: input.failureUrl };
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

    // 1b. Amount must be positive at the 8dp money scale. The amount schema's
    //     regex accepts "0" (and sub-unit values that round to 0), which would
    //     mint a PENDING link that can never settle and would violate the ledger
    //     amount>0 CHECK. Reject up front, same as ingest/withdrawal/payout/load.
    if (!Money.of(input.amount).round().isPositive()) {
      throw new ValidationError('amount must be positive at up to 8 decimal places');
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

    let created: WhishPayment;
    try {
      created = await this.prisma.runAsTenant(companyId, (tx) =>
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
    } catch (err) {
      // A concurrent retry with the same idempotencyKey raced us to the unique
      // (companyId, idempotencyKey) insert. Return the original link instead of a
      // 409 — the check-then-create above can't see the in-flight winner.
      if (
        input.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.runAsTenant(companyId, (tx) =>
          tx.whishPayment.findFirst({
            where: { companyId, idempotencyKey: input.idempotencyKey },
          }),
        );
        if (existing) return mapWhishPayment(existing);
      }
      throw err;
    }

    const externalId = Number(created.externalId);
    const apiBase = this.config.get('WHISH_CALLBACK_BASE', { infer: true });
    const webBase = this.config.get('WEB_ORIGIN', { infer: true });
    const q = `token=${callbackToken}&externalId=${externalId}`;

    // Where the PAYER lands after paying. Precedence: per-link override (input)
    // → the company's saved default → the platform's /pay pages. Each carries
    // ?ref=<externalId> so the destination can identify the payment. NOTE: only
    // the customer-facing REDIRECT; the success/failure CALLBACK URLs above stay
    // platform-controlled (they carry the settlement token).
    const defaults = await this.prisma.runAsTenant(companyId, (tx) =>
      tx.company.findUnique({
        where: { id: companyId },
        select: { whishSuccessRedirectUrl: true, whishFailureRedirectUrl: true },
      }),
    );
    const successRedirectUrl = withRef(
      input.successRedirectUrl ?? defaults?.whishSuccessRedirectUrl ?? `${webBase}/pay/success`,
      externalId,
    );
    const failureRedirectUrl = withRef(
      input.failureRedirectUrl ?? defaults?.whishFailureRedirectUrl ?? `${webBase}/pay/failure`,
      externalId,
    );

    try {
      const { collectUrl } = await this.whish.postPayment({
        amount: input.amount,
        currency: input.currency,
        invoice: input.invoice,
        externalId,
        successCallbackUrl: `${apiBase}/whish/callback/success?${q}`,
        failureCallbackUrl: `${apiBase}/whish/callback/failure?${q}`,
        successRedirectUrl,
        failureRedirectUrl,
      });

      // Super-admin log: what we asked Whish for, and what Whish returned.
      this.txLogs.record({
        kind: 'WHISH_LINK',
        companyId,
        sourceCode: WHISH_SOURCE_CODE,
        reference: String(externalId),
        statusCode: 200,
        success: true,
        request: {
          amount: input.amount,
          currency: input.currency,
          invoice: input.invoice,
          externalId,
        },
        response: { collectUrl },
      });

      const updated = await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.update({ where: { id: created.id }, data: { collectUrl } }),
      );
      this.logger.log(
        `Whish link created: company=${companyId} externalId=${externalId} amount=${input.amount} ${input.currency}`,
      );
      this.realtime.company(companyId, ['whish']);
      // Push a PENDING transaction to the company's CRM right away — it flips to
      // COMPLETED via the settlement ingest (same `whish:<externalId>` reference).
      this.crm.emitWhish({
        companyId,
        externalId,
        amount: input.amount,
        currency: input.currency,
        invoice: input.invoice,
        event: 'transaction.pending',
      });
      return mapWhishPayment(updated);
    } catch (err) {
      // Super-admin log: what we asked Whish for, and what Whish returned on
      // failure (the raw envelope is carried on WhishError.upstreamResponse,
      // kept off `details` so it never reaches the API caller).
      const details = err instanceof WhishError ? err.details : undefined;
      const upstreamResponse = err instanceof WhishError ? err.upstreamResponse : undefined;
      this.txLogs.record({
        kind: 'WHISH_LINK',
        companyId,
        sourceCode: WHISH_SOURCE_CODE,
        reference: String(externalId),
        statusCode: typeof details?.httpStatus === 'number' ? details.httpStatus : 502,
        success: false,
        request: {
          amount: input.amount,
          currency: input.currency,
          invoice: input.invoice,
          externalId,
        },
        response: {
          code: err instanceof WhishError ? err.code : 'WHISH_ERROR',
          message: err instanceof Error ? err.message : 'unknown',
          upstream: upstreamResponse ?? details?.upstreamMessage ?? null,
        },
      });
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
      this.crm.emitWhish({
        companyId,
        externalId,
        amount: input.amount,
        currency: input.currency,
        invoice: input.invoice,
        event: 'transaction.failed',
      });
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
      if (query.needsAttention === 'true')
        where.metadata = { path: ['needsAttention'], equals: true };
      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
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
    // Constant-time compare of the unguessable per-payment token (matches the
    // project's timing-safe posture for secrets elsewhere, e.g. the /metrics gate).
    const expectedToken = Buffer.from(payment.callbackToken);
    const providedToken = Buffer.from(token);
    if (
      expectedToken.length !== providedToken.length ||
      !crypto.timingSafeEqual(expectedToken, providedToken)
    ) {
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
      // Guard on still-PENDING: a delayed 'failed' status from Whish must never
      // overwrite a payment a concurrent callback/settle already moved to PAID.
      const res = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.updateMany({
          where: { id: payment.id, status: WhishPaymentStatus.PENDING },
          data: { status: WhishPaymentStatus.FAILED, payerPhoneNumber },
        }),
      );
      const current = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.findUniqueOrThrow({ where: { id: payment.id } }),
      );
      if (res.count === 1) {
        this.logger.log(`Whish payment ${payment.externalId} FAILED`);
        this.realtime.company(payment.companyId, ['whish']);
        this.crm.emitWhish({
          companyId: payment.companyId,
          externalId: payment.externalId,
          amount: payment.amount.toString(),
          currency,
          invoice: payment.invoice,
          payerPhoneNumber,
          event: 'transaction.failed',
        });
      }
      return mapWhishPayment(current);
    }

    // Settlement is OPT-IN: ONLY an explicit 'success' credits money. The client
    // already validates collectStatus against z.enum(['success','failed','pending']),
    // so by type this is 'success' here — the cast keeps this as a runtime
    // backstop should the contract ever widen or the client guard be removed: an
    // off-contract status must NEVER fall through to the credit path. Treat it
    // like paid-but-unsettled: log, flag for an operator, leave PENDING for
    // retry, and do NOT touch the wallet/ledger.
    if ((collectStatus as string) !== 'success') {
      this.logger.error(
        `Whish payment ${payment.externalId} returned unexpected collectStatus '${String(collectStatus)}' ` +
          `(company ${payment.companyId}) — NOT crediting; flagging for operator and leaving PENDING for retry.`,
      );
      const flagged = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.update({
          where: { id: payment.id },
          data: {
            metadata: { needsAttention: true, unknownStatus: String(collectStatus) },
          },
        }),
      );
      this.realtime.company(payment.companyId, ['whish']);
      return mapWhishPayment(flagged);
    }

    // success → the customer paid. Before crediting, re-check the CURRENT row
    // status: the `payment` snapshot can be stale (this method is reached from a
    // manual refresh and the stale-reconcile job), and we must NEVER book money
    // against a link that already reached a terminal state. If it's already PAID a
    // concurrent winner settled it — return. If it's EXPIRED/FAILED the customer
    // paid AFTER the link died ("paid after expiry"): silently crediting would
    // leave real money against a record that says it never collected and orphan
    // the ledger transaction, so flag it for an operator and do NOT auto-credit.
    const before = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id: payment.id } }),
    );
    if (before.status === WhishPaymentStatus.PAID) return mapWhishPayment(before);
    if (before.status !== WhishPaymentStatus.PENDING) {
      this.logger.error(
        `Whish payment ${payment.externalId} is SUCCESS at Whish but local row is ${before.status} ` +
          `(company ${payment.companyId}) — paid after expiry; flagging for operator, NOT auto-crediting.`,
      );
      const flagged = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.update({
          where: { id: payment.id },
          data: { metadata: { needsAttention: true, paidAfterExpiry: true } },
        }),
      );
      this.realtime.company(payment.companyId, ['whish']);
      return mapWhishPayment(flagged);
    }

    // Still PENDING → settle. Write a ledger Transaction via the existing ingest
    // pipeline (commission + ledger + wallet credit), then mark PAID.
    const source = await this.resolveWhishSource();
    let txn: { id: string };
    try {
      txn = await this.transactions.ingest(
        // WHISH_PAY channel: this deposit is a Whish collect-link settlement, so it
        // is priced on the source's WHISH_PAY fee schedule (not direct INGEST).
        { kind: 'source', sourceId: source.id, channel: SourceFeeChannel.WHISH_PAY },
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
    } catch (err) {
      // A concurrent settle (the success callback racing the 60s stale-reconcile
      // job or a manual refresh) makes the LOSER's ingest hit the
      // (sourceId, externalTransactionId) unique constraint (P2002). That is NOT a
      // settlement failure — the winner already booked the money — so recover the
      // existing transaction and fall through to mark PAID, instead of flagging.
      // ingest() now translates that P2002 into a DuplicateTransactionError, so
      // accept either form.
      if (
        err instanceof DuplicateTransactionError ||
        (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      ) {
        const existing = await this.prisma.runAsAdmin((tx) =>
          tx.transaction.findFirst({
            where: { sourceId: source.id, externalTransactionId: String(payment.externalId) },
            select: { id: true },
          }),
        );
        if (!existing) throw err;
        txn = existing;
      } else {
        // Genuine failure: Whish has the customer's money but we can't settle it —
        // almost always because the link's commission rule was changed/deactivated
        // after it was minted, so ingest can't resolve a price. NEVER let collected
        // money sit invisibly stuck: flag it for operator attention (ERROR + a
        // persisted metadata marker + a realtime nudge), then rethrow so the
        // stale-reconcile retry picks it up next tick.
        const message = err instanceof Error ? err.message : 'settlement failed';
        this.logger.error(
          `Whish payment ${payment.externalId} is PAID at Whish but could NOT be settled (company ${payment.companyId}): ${message}. Left PENDING for retry — needs operator attention (likely its commission rule changed after the link was created).`,
        );
        await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.update({
            where: { id: payment.id },
            data: {
              metadata: { needsAttention: true, paidButUnsettled: true, settlementError: message },
            },
          }),
        );
        this.realtime.company(payment.companyId, ['whish']);
        throw err;
      }
    }

    // Guard the settle on still-PENDING so only ONE racer marks it PAID and fires
    // the side effects. A concurrent winner (the success callback racing this
    // stale-reconcile/manual refresh) already booked the SAME transaction (the
    // (source, externalId) unique constraint guarantees it), so the loser must
    // not double-deliver the webhook or re-stamp paidAt.
    const settled = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id: payment.id, status: WhishPaymentStatus.PENDING },
        data: {
          status: WhishPaymentStatus.PAID,
          transactionId: txn.id,
          payerPhoneNumber,
          paidAt: new Date(),
          // Clear any prior paid-but-unsettled marker so a recovered payment stops
          // showing as "needs attention".
          metadata: Prisma.JsonNull,
        },
      }),
    );
    const updated = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id: payment.id } }),
    );
    // Recover the narrow race the PENDING pre-check can't close: the row passed the
    // pre-check as PENDING but a concurrent expire flipped it out of PENDING while
    // `ingest` was in flight, so this settle matched 0 rows. We already booked a
    // real transaction, so don't orphan it — link it, mark PAID (it WAS paid), and
    // flag paid-after-expiry for an operator. (count===0 with status already PAID is
    // the benign concurrent-winner case — they booked the same txn — so skip it.)
    if (settled.count === 0 && updated.status !== WhishPaymentStatus.PAID) {
      this.logger.error(
        `Whish payment ${payment.externalId} booked transaction ${txn.id} but row was ${updated.status} at settle ` +
          `(company ${payment.companyId}) — recovering: linking transaction + flagging paid-after-expiry.`,
      );
      const recovered = await this.prisma.runAsAdmin((tx) =>
        tx.whishPayment.update({
          where: { id: payment.id },
          data: {
            status: WhishPaymentStatus.PAID,
            transactionId: txn.id,
            payerPhoneNumber,
            paidAt: new Date(),
            metadata: { needsAttention: true, paidAfterExpiry: true },
          },
        }),
      );
      this.realtime.company(payment.companyId, ['whish']);
      return mapWhishPayment(recovered);
    }
    if (settled.count === 1) {
      this.logger.log(
        `Whish payment ${payment.externalId} PAID → transaction ${txn.id} (company ${payment.companyId})`,
      );
      // Notify the company's webhook (best-effort, never blocks settlement). The
      // .catch is required: this is a detached promise, and deliverPaid's first DB
      // lookup is outside its own try/catch, so a transient DB error here would
      // otherwise become an unhandled rejection.
      void this.webhooks
        .deliverPaid(updated)
        .catch((e) =>
          this.logger.warn(
            `Whish webhook delivery failed for ${payment.externalId}: ${(e as Error).message}`,
          ),
        );
    }
    // `transactions.ingest` already announced transactions/wallets/ledger;
    // this refreshes the Whish payment views.
    this.realtime.company(payment.companyId, ['whish']);
    return mapWhishPayment(updated);
  }

  /**
   * Background reconciliation: pull status for stale PENDING payments (a
   * callback may have been missed), and give up on very old ones (→ FAILED,
   * since Whish has no "expired" status to distinguish a lapse from a decline).
   * No-op when Whish isn't configured. Returns a small summary for logging.
   */
  async reconcileStalePayments(): Promise<{ checked: number; timedOut: number }> {
    if (!this.whish.isConfigured()) return { checked: 0, timedOut: 0 };

    const now = Date.now();
    const youngerThan = new Date(now - RECONCILE_MIN_AGE_MS);
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findMany({
        where: {
          status: WhishPaymentStatus.PENDING,
          createdAt: { lt: youngerThan },
          // NOTE: the needs-attention exclusion is done in JS below, NOT here.
          // A SQL `NOT (metadata->needsAttention = true)` silently DROPS every row
          // whose metadata is NULL — which is every normal pending payment — so
          // this query was returning nothing and the poller never reconciled
          // anything (failed/expired only ever resolved on a manual refresh).
        },
        orderBy: { createdAt: 'asc' },
        // Poll the whole stale-pending set (bounded), not just the oldest 50 —
        // otherwise a backlog starves newer links and a failed payment can't reach
        // the CRM until a manual refresh.
        take: RECONCILE_MAX_PER_TICK,
      }),
    );
    if (rows.length === RECONCILE_MAX_PER_TICK) {
      // Hit the per-tick safety cap — a real backlog. We still drain the rest on
      // subsequent ticks (oldest first), but flag it so the cap can be raised.
      this.logger.warn(
        `Reconciliation hit the ${RECONCILE_MAX_PER_TICK}-link cap this tick; remaining stale links roll to the next tick.`,
      );
    }

    let timedOut = 0;
    for (const p of rows) {
      // Skip paid-but-unsettled rows: Whish HAS the customer's money but we
      // couldn't book it (e.g. its commission rule changed) — they stay PENDING +
      // needsAttention for an operator, not for re-polling. (Done here, not in the
      // SQL WHERE, so a NULL metadata — every normal pending payment — is NOT
      // dropped; that bug is what kept the poller from selecting anything.)
      if ((p.metadata as { needsAttention?: boolean } | null)?.needsAttention === true) continue;
      const tooOld = now - p.createdAt.getTime() > EXPIRE_AGE_MS;
      try {
        // Always ask Whish for the authoritative status first — never time out a
        // payment that actually settled just before the cutoff.
        const result = await this.reconcile(p);
        // Whish only ever reports success | failed | pending — it has NO "expired"
        // status, so we can't tell a decline from a lapsed link. A link still
        // PENDING past our cutoff is one Whish never resolved; we collapse it into
        // the same terminal as a Whish 'failed' (one non-success signal for the
        // CRM). Never do this to a paid-but-unsettled link (needsAttention): Whish
        // HAS the money but we couldn't book it — that needs an operator, not a
        // silent fail.
        if (tooOld && result.status === WhishPaymentStatus.PENDING && !result.needsAttention) {
          // Guard on the row STILL being PENDING. reconcile() acted on a stale
          // snapshot; a success callback may have settled it to PAID meanwhile.
          // Without the status guard we'd overwrite a real PAID payment — a
          // self-contradictory, corrupt record.
          const res = await this.prisma.runAsAdmin((tx) =>
            tx.whishPayment.updateMany({
              where: { id: p.id, status: WhishPaymentStatus.PENDING },
              data: { status: WhishPaymentStatus.FAILED },
            }),
          );
          if (res.count === 1) {
            this.realtime.company(p.companyId, ['whish']);
            this.crm.emitWhish({
              companyId: p.companyId,
              externalId: p.externalId,
              amount: p.amount.toString(),
              currency: p.currency.trim(),
              invoice: p.invoice,
              event: 'transaction.failed',
            });
            timedOut++;
          }
        }
      } catch (err) {
        // Couldn't reach Whish — leave it PENDING and retry next run rather than
        // blindly expiring a possibly-paid payment.
        this.logger.warn(`Reconcile failed for payment ${p.externalId}: ${(err as Error).message}`);
      }
    }
    return { checked: rows.length, timedOut };
  }

  /** Admin: list Whish payments across all companies. */
  async listAll(query: ListWhishPaymentsQuery): Promise<PaginatedResponse<WhishPaymentResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.WhishPaymentWhereInput = {};
      if (query.status) where.status = query.status;
      // Operators can filter to just the stuck (paid-but-unsettled) payments.
      if (query.needsAttention === 'true')
        where.metadata = { path: ['needsAttention'], equals: true };
      const skip = (query.page - 1) * query.pageSize;
      assertListOffset(skip);
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

/** Append `ref=<externalId>` to a redirect URL, respecting any existing query. */
function withRef(base: string, externalId: number): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ref=${externalId}`;
}

function mapWhishPayment(row: WhishPayment): WhishPaymentResponse {
  const meta = (row.metadata as { needsAttention?: unknown } | null) ?? null;
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
    needsAttention: meta?.needsAttention === true,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}
