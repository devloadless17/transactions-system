import { Injectable, Logger, type StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import {
  isLoopbackUrl,
  Money,
  MONEY_SCALE_LABEL,
  SourceFeeChannel,
  WHISH_CURRENCIES,
  type CreateWhishPaymentInput,
  type ListWhishPaymentsQuery,
  type PaginatedResponse,
  type SetWhishRedirectConfigInput,
  type SupportedCurrency,
  type WhishClientConfig,
  type WhishCurrency,
  type WhishPaymentResponse,
  type WhishRedirectConfig,
  WhishPaymentStatus,
  whishAmountIssue,
} from '@app/shared';
import { Prisma } from '@app/db';
import type { WhishPayment } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import {
  ConflictError,
  DomainError,
  DuplicateTransactionError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { streamCsvKeyset } from '../../common/csv';
import { BACKOFFICE_SETTLEMENT_ERROR } from '../../common/backoffice-view';
import { TransactionsService } from '../transactions/transactions.service';
import { CommissionResolverService } from '../commissions/commission-resolver.service';
import { CommissionsRepository } from '../commissions/commissions.repository';
import { WhishClient, WhishError, WhishIndeterminateError } from './whish.client';
import type { WhishCollectStatus } from './whish.client';
import { WhishWebhookService } from './whish-webhook.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CrmDispatchService } from '../crm/crm-dispatch.service';
import { TransactionLogsService } from '../transaction-logs/transaction-logs.service';

const WHISH_SOURCE_CODE = 'whish';
// The reconciliation poller's timing follows what Whish does with a link.
// Measured on production (2026-10: ~22,500 links, 2,655 of them unpaid in the
// last 60 days):
//   - Whish tells us itself the moment a link is paid (the success callback),
//     so an open link is NOT asked about while it can still be paid: half of
//     all paid links are paid within 22 seconds, 99% within 3 minutes.
//   - Whish closes an unpaid link 5 minutes after it created it and never says
//     so; asking is the only way to learn it. Asked once a minute, as the
//     poller used to, the close showed up evenly between 5:01 and 6:01 after
//     OUR row was created (all but 3 links) — so Whish's own close falls within
//     a second or two of 5:00.
// So every link gets ONE scheduled check, 10 seconds after Whish closes it:
// that check finds an unpaid link closed (it used to take about six), and it
// books a payment whose callback never reached us.
export const FIRST_POLL_AGE_MS = 5 * 60_000 + 10_000;
// A TRANSIENT settlement failure (DB blip, exhausted serializable retries — NOT a
// DomainError) stays in the poller's retry set; only after this many consecutive
// failed attempts is it parked as needsAttention for an operator. Permanent
// config errors (DomainError, e.g. NO_COMMISSION_RULE or a deactivated company)
// park immediately — retrying every 60s can't fix configuration. Settlement
// deliberately keeps STRICT pricing (unlike the external HTTP ingest, which
// books pricing gaps at net 0): a parked link settles AT THE CORRECT FEE via
// admin Refresh once pricing is fixed, which beats an irreversible net-0 booking.
const TRANSIENT_SETTLE_PARK_AFTER = 10;
// A link Whish still reports unpaid ('pending') this long after it was created
// is closed (→ FAILED): Whish's own close has never come this late.
const EXPIRE_AGE_MS = 10 * 60_000;
// 'unknown' is different: Whish cannot say whether it collected, so the money
// may be ours and closing it would tell the company's CRM a paid deposit
// failed. Those links are asked about until Whish answers; one still unknown
// after this long is closed AND flagged for an operator.
const UNKNOWN_EXPIRE_AGE_MS = 24 * 3600_000;
// A link creation still waiting on Whish is done within this (the Whish call
// times out after 10s): a link-less row older than this is not in flight.
const MINT_IN_FLIGHT_MS = 60_000;
// Max pending links polled per reconciliation run. Whish calls back per ATTEMPT
// — a failure callback means one attempt failed while the link stays payable —
// and never when a link finally expires, so polling is the ONLY way
// failed/abandoned links reach the CRM live. Which links are polled is decided
// by their schedule (next_poll_at, see nextPollDelayMs): the earliest-due
// first, so a backlog can delay a link but never starve it. A full run is
// followed by the next one at once (WhishReconciliationService), so this is the
// size of one batch, not a ceiling per minute.
const RECONCILE_MAX_PER_TICK = 250;
// Links polled at the same time within a run — the bound on Whish API calls in
// flight, however large the backlog. Each poll is one Whish call (~0.3s), so
// this is about 3,200 links a minute: more than the platform can create, so
// unpaid links are confirmed as fast as they are made, at any load. Whish puts
// no limit on our account; if it ever answers 429 the run stops (see
// pollStaleLink). Each check holds a database connection only for its short
// writes, never across the Whish call.
export const RECONCILE_CONCURRENCY = 16;
// A refund call answers within the client's 10s timeout. A refund request older
// than this is no longer in flight, so if Whish still reports the payment as
// paid, Whish did not refund it and the request can be released for a retry.
const REFUND_IN_FLIGHT_MS = 2 * 60_000;
const REFUND_ALREADY_SENT =
  'A refund for this payment was already sent to Whish. Press Refresh to confirm its outcome.';
// Both are shown to the company too (needsAttention reads settlementError), so
// they say what happened, not which admin button resolves it.
const REFUND_UNCONFIRMED =
  'A refund was sent to Whish but is not confirmed yet; nothing has been booked.';
const REFUNDED_NOT_BOOKED =
  'Whish refunded this payment, but booking the refund failed; nothing has been booked yet.';

/**
 * When to ask Whish again about a link that is still unresolved, by its age.
 *
 * A link asked about before its first check (something made it due early: a
 * callback we could not act on, a row without a schedule) goes back to that
 * check — it is still payable, and Whish reports a payment itself. From the
 * first check to the unpaid-link cutoff (EXPIRE_AGE_MS) Whish should already
 * have closed it: asked every minute. Nothing ordinary lives past the cutoff —
 * only a link Whish reports as 'unknown' — and those are asked about every 5
 * minutes.
 */
export function nextPollDelayMs(ageMs: number): number {
  if (ageMs < FIRST_POLL_AGE_MS) return FIRST_POLL_AGE_MS - ageMs;
  return ageMs < EXPIRE_AGE_MS ? 60_000 : 5 * 60_000;
}

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

    // 1b. Amount must be positive at the platform money scale. The amount schema's
    //     regex accepts "0" (and sub-unit values that round to 0), which would
    //     mint a PENDING link that can never settle and would violate the ledger
    //     amount>0 CHECK. Reject up front, same as ingest/withdrawal/payout/load.
    // Quantized at the boundary — the HTTP schema already does this, but keeping
    // it here means the persisted row is at scale no matter which caller got here,
    // and the row is what settlement later books.
    const amount = Money.of(input.amount).round();
    if (!amount.isPositive()) {
      throw new ValidationError(`amount must be positive at up to ${MONEY_SCALE_LABEL}`);
    }

    // 1c. Whish DOCUMENTS per-currency amount rules (v1.4.4: USD at most 2
    //     decimals, minimum 1.00) but does not enforce them: verified against the
    //     live sandbox, it mints a real link for "0.50" and "10.005", and the
    //     hosted page takes a 0.50 link to the OTP step. So this is a WARNING,
    //     never a rejection — refusing here would block money the provider is
    //     willing to collect. If Whish ever starts enforcing it, these log lines
    //     are the early warning.
    const amountIssue = whishAmountIssue(input.amount, input.currency);
    if (amountIssue) {
      this.logger.warn(
        `Whish amount outside the documented range (company ${companyId}): ${amountIssue}. ` +
          `Forwarding ${input.amount} ${input.currency} anyway — Whish accepts it today.`,
      );
    }

    // 2. Commission must resolve up front — never mint a link that can't
    //    settle. (Without this, a paid payment with no matching rule would be
    //    stuck PENDING forever.) This is also what makes enabling LBP safe:
    //    if no LBP rule covers the amount, creation fails clearly here instead
    //    of after the customer has paid.
    const source = await this.resolveWhishSource();
    await this.assertCommissionResolves(companyId, source.id, amount.toString());

    // Idempotency: a retried create with the same key returns the original —
    // EXCEPT when the original is a linkless orphan (see isLinklessOrphan), where
    // the retry re-attempts the mint instead of handing back a payment that can
    // never be paid.
    if (input.idempotencyKey) {
      const prior = await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.findFirst({ where: { companyId, idempotencyKey: input.idempotencyKey } }),
      );
      if (prior) {
        if (!isLinklessOrphan(prior)) return mapWhishPayment(prior);
        assertRetryMatchesRow(prior, input);
        return this.mintLink(companyId, prior, input);
      }
    }

    const callbackToken = crypto.randomBytes(24).toString('base64url');

    let created: WhishPayment;
    try {
      created = await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.create({
          data: {
            companyId,
            callbackToken,
            amount: amount.toString(),
            currency: input.currency,
            invoice: input.invoice,
            idempotencyKey: input.idempotencyKey ?? null,
            status: WhishPaymentStatus.PENDING,
            // On the poller's schedule from birth (see FIRST_POLL_AGE_MS).
            nextPollAt: new Date(Date.now() + FIRST_POLL_AGE_MS),
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
        if (existing) {
          if (!isLinklessOrphan(existing)) return mapWhishPayment(existing);
          assertRetryMatchesRow(existing, input);
          return this.mintLink(companyId, existing, input);
        }
      }
      throw err;
    }

    return this.mintLink(companyId, created, input);
  }

  /**
   * Ask Whish for the collect URL and finish the row. Split out of createPayment
   * so an idempotent retry of a linkless orphan (a create whose outcome Whish
   * could not confirm) can re-attempt the SAME externalId rather than handing
   * back a payment with no payable link. Whish replays the original result for a
   * repeated externalId, so this recovers the link if it was in fact minted.
   */
  private async mintLink(
    companyId: string,
    created: WhishPayment,
    input: CreateWhishPaymentInput,
  ): Promise<WhishPaymentResponse> {
    const callbackToken = created.callbackToken;
    // Whish v1.4.4 documents externalId as a String, so keep it a digit string
    // from here on — it is also what every downstream consumer already wants
    // (the ledger reference, the CRM `whish:<id>` reference, the API response).
    const externalId = created.externalId.toString();
    // The persisted row is the source of truth for what we ask Whish to collect:
    // it is what settlement will credit, and on a retry it is what already exists.
    const amount = created.amount.toString();
    const currency = created.currency;
    const invoice = created.invoice;
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
    // Loopback defaults saved BEFORE validation existed (or that slipped past
    // it) would make Whish reject the link with a bare 403 on EVERY payment —
    // the original incident. Treat such a stored default as absent so old rows
    // self-heal onto the platform pages instead of failing forever; the schema
    // still rejects new saves, and the dashboard shows the stale value to fix.
    const usable = (url: string | null | undefined): string | null =>
      url && !isLoopbackUrl(url) ? url : null;
    const successRedirectUrl = withRef(
      input.successRedirectUrl ??
        usable(defaults?.whishSuccessRedirectUrl) ??
        `${webBase}/pay/success`,
      externalId,
    );
    const failureRedirectUrl = withRef(
      input.failureRedirectUrl ??
        usable(defaults?.whishFailureRedirectUrl) ??
        `${webBase}/pay/failure`,
      externalId,
    );

    try {
      const { collectUrl } = await this.whish.postPayment({
        // From the ROW, never the request body. On an orphan retry the two can
        // disagree, and settlement always credits the row — minting a link for a
        // different amount than we would book is how a payment silently collects
        // the wrong money.
        amount: amount,
        currency: currency,
        invoice: invoice,
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
        tx.whishPayment.update({
          where: { id: created.id },
          // Whish's 5 minutes run from NOW, the moment it made the link — on a
          // retried orphan that is long after the row was created.
          data: { collectUrl, nextPollAt: new Date(Date.now() + FIRST_POLL_AGE_MS) },
        }),
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
          indeterminate: err instanceof WhishIndeterminateError,
        },
      });

      // INDETERMINATE (Whish v1.4.4 `code:500`, a timeout, or a 5xx): the link
      // MAY exist upstream, so this is NOT a failure. Leave the row PENDING —
      // it already is, and it carries the externalId the reconciler polls by —
      // and let the reconciliation poller resolve it at its first check.
      //
      // Marking it FAILED here would be UNRECOVERABLE: the poller only selects
      // PENDING rows, so a FAILED row is never re-checked, and if Whish did mint
      // the link and the customer pays, settlement lands in the paid-after-expiry
      // branch and needs a human. For the same reason the CRM gets
      // `transaction.pending` (which truthfully mirrors the row and shares the
      // `whish:<externalId>` reference the eventual terminal event will use), NOT
      // `transaction.failed` — that would assert a settled non-collection that
      // has not happened.
      if (err instanceof WhishIndeterminateError) {
        await this.prisma.runAsTenant(companyId, (tx) =>
          tx.whishPayment.update({
            where: { id: created.id },
            data: {
              metadata: mergeMetadata(created.metadata, {
                linkCreateIndeterminate: true,
                error: err instanceof Error ? err.message : 'unknown',
              }),
            },
          }),
        );
        this.logger.warn(
          `Whish link creation INDETERMINATE: company=${companyId} externalId=${externalId} — ` +
            `row left PENDING for the reconciler (${err.message})`,
        );
        this.realtime.company(companyId, ['whish']);
        this.crm.emitWhish({
          companyId,
          externalId,
          amount: input.amount,
          currency: input.currency,
          invoice: input.invoice,
          event: 'transaction.pending',
        });
        // Re-thrown carrying the identifiers, because the create call returns no
        // body: without these the caller cannot look the payment up, and both
        // recovery routes we document would dead-end.
        throw new WhishIndeterminateError(
          err.message,
          { ...err.details, externalId, paymentId: created.id },
          err.upstreamResponse,
        );
      }

      await this.prisma.runAsTenant(companyId, (tx) =>
        tx.whishPayment.update({
          where: { id: created.id },
          data: {
            status: WhishPaymentStatus.FAILED,
            metadata: mergeMetadata(created.metadata, {
              error: err instanceof Error ? err.message : 'unknown',
            }),
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

  /**
   * Build the Prisma `where` shared by the list, admin-list and CSV exports so a
   * filter (status / needs-attention / date range / text search) means the same
   * thing everywhere. `scope.companyId` pins a company-scoped view; otherwise the
   * admin `companyId` query param (if any) is honoured.
   */
  private listWhere(
    query: ListWhishPaymentsQuery,
    scope: { companyId?: string },
  ): Prisma.WhishPaymentWhereInput {
    const where: Prisma.WhishPaymentWhereInput = {};
    if (scope.companyId) where.companyId = scope.companyId;
    else if (query.companyId) where.companyId = query.companyId;
    if (query.status) where.status = query.status;
    if (query.needsAttention === 'true')
      where.metadata = { path: ['needsAttention'], equals: true };
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    // Fuzzy search across the free-text invoice, the payer phone, and — when the
    // term is purely numeric — the numeric reference (externalId, a bigint). This
    // is what lets a company find a link by an MT5 / OWM / order id buried in the
    // invoice text (e.g. "OWM-E6CE3F70 • MT5 5000123 • ID E2E-9988776655").
    if (query.search) {
      const s = query.search;
      const or: Prisma.WhishPaymentWhereInput[] = [
        { invoice: { contains: s, mode: 'insensitive' } },
        { payerPhoneNumber: { contains: s, mode: 'insensitive' } },
      ];
      // Only treat a bounded all-digits term as a reference — kept within int64 so
      // a giant number can never make Prisma range-error on the bigint column.
      if (/^\d{1,18}$/.test(s)) or.push({ externalId: BigInt(s) });
      where.OR = or;
    }
    return where;
  }

  async list(
    companyId: string,
    query: ListWhishPaymentsQuery,
  ): Promise<PaginatedResponse<WhishPaymentResponse>> {
    return this.prisma.runAsTenant(companyId, async (tx) => {
      const where = this.listWhere(query, { companyId });
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
  /**
   * Handle Whish's callback for one payment. Resolves `true` when the callback
   * was AUTHENTIC — the payment exists and the per-payment secret token matched
   * — whatever the settlement outcome; `false` for an unknown id or a wrong
   * token. Never throws for either: the endpoint always answers 200. The
   * controller uses the answer to limit only FAKE callbacks (see
   * WhishCallbackController), so a genuine one is never refused.
   */
  async handleCallback(externalId: number, token: string): Promise<boolean> {
    const payment = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUnique({ where: { externalId: BigInt(externalId) } }),
    );
    if (!payment) {
      this.logger.warn(`Whish callback for unknown externalId=${externalId}`);
      return false;
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
      return false;
    }
    try {
      await this.reconcile(payment);
    } catch (err) {
      // Swallow — Whish only needs a 200. Whish will not call again for this
      // attempt, and the poller leaves a link alone while it is still payable,
      // so make it due now: the next poller run retries what we could not
      // finish here, instead of the first scheduled check minutes later.
      this.logger.error(`Whish callback reconcile failed externalId=${externalId}`, err as Error);
      await this.scheduleNextPoll(payment.id, Date.now());
    }
    return true;
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

  /**
   * Admin (cross-company) reconcile of one payment by id. Same authoritative
   * settlement path as the company-facing refresh, but not tenant-scoped — a
   * platform admin can re-attempt ANY company's stuck payment. This is the
   * operator's recovery for a paid-but-unsettled link: the 60s poller skips
   * needsAttention rows, so once the underlying cause is fixed (e.g. the company
   * made visible again) a manual refresh is what re-books it.
   *
   * On a PAID payment it settles the refund state instead, which nothing else
   * re-checks (the poller only takes PENDING links) — see refreshPaidPayment.
   */
  async adminRefreshStatus(id: string, actorId: string): Promise<WhishPaymentResponse> {
    const payment = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUnique({ where: { id } }),
    );
    if (!payment) throw new NotFoundError('WhishPayment', id);
    if (payment.status === WhishPaymentStatus.PAID)
      return this.refreshPaidPayment(payment, actorId);
    return this.reconcile(payment);
  }

  /**
   * Admin Refresh of a SETTLED payment — what does Whish say about it now?
   *  - `refunded` after a refund WE sent: book it. This is how a refund whose
   *    outcome Whish could not report at the time gets booked.
   *  - `refunded` with no refund from us: it was refunded outside the platform.
   *    Flag it and book NOTHING — reversing the ledger stays a deliberate
   *    operator action (the Refund button records it without paying again).
   *  - `success` with a refund request that is no longer in flight: Whish did
   *    not refund it, so release the request and let the operator try again.
   */
  private async refreshPaidPayment(
    payment: WhishPayment,
    actorId: string,
  ): Promise<WhishPaymentResponse> {
    let collectStatus: WhishCollectStatus;
    try {
      ({ collectStatus } = await this.whish.getStatus({
        currency: payment.currency.trim(),
        externalId: payment.externalId.toString(),
      }));
    } catch (err) {
      // Refreshing an already-settled payment used to be a guaranteed no-op, so
      // an upstream outage must not turn it into a 502 for the operator.
      this.logger.warn(
        `Whish status check failed for settled payment ${payment.externalId} (${err instanceof Error ? err.message : 'unknown'}) — ` +
          `returning the row unchanged.`,
      );
      return mapWhishPayment(payment);
    }

    if (collectStatus === 'refunded') {
      if (payment.refundRequestedAt) return this.bookRefund(payment.id, actorId);
      return this.flagRefundedOutside(payment);
    }
    if (
      collectStatus === 'success' &&
      payment.refundRequestedAt &&
      Date.now() - payment.refundRequestedAt.getTime() > REFUND_IN_FLIGHT_MS
    ) {
      this.logger.warn(
        `Whish payment ${payment.externalId}: the refund requested at ${payment.refundRequestedAt.toISOString()} ` +
          `was not made (Whish still reports it paid) — releasing it for a retry.`,
      );
      return this.releaseRefund(payment.id);
    }
    return mapWhishPayment(payment);
  }

  /**
   * Flag a settled payment Whish reports as refunded although we never asked it
   * to (refunded in Whish's own portal). The wallet is still credited, so it
   * needs an operator; nothing is booked here.
   */
  private async flagRefundedOutside(payment: WhishPayment): Promise<WhishPaymentResponse> {
    this.logger.error(
      `Whish payment ${payment.externalId} was REFUNDED after settling (company ${payment.companyId}, ` +
        `transaction ${payment.transactionId ?? 'none'}) — wallet still credited; needs an operator to record the refund.`,
    );
    const flagged = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: payment.id },
        // Merged, not replaced: a row can already carry `paidAfterExpiry` or a
        // settlement breadcrumb, and losing it hides half the story.
        data: {
          metadata: mergeMetadata(payment.metadata, {
            needsAttention: true,
            refundedAfterSettlement: true,
            // needsAttention is surfaced to the company as "settlement needs
            // attention — read settlementError", so it must never be flagged
            // with a null reason.
            settlementError:
              'Whish reports this payment as refunded after it settled — the wallet credit has not been reversed yet; an operator needs to record the refund.',
          }),
        },
      }),
    );
    this.realtime.company(payment.companyId, ['whish']);
    return mapWhishPayment(flagged);
  }

  /**
   * Admin: refund a PAID payment to its payer through Whish, and reverse its
   * settled deposit. Always the full amount — Whish's refund call takes none.
   *
   * Real money leaves the platform's Whish account, so the order is strict:
   *   1. LOCK  — set refund_requested_at on a PAID row that has none. A double
   *              click or a second operator is refused, so Whish is asked to
   *              refund a payment at most once per request.
   *   2. CHECK — ask Whish for the payment's status. Already `refunded` (e.g. in
   *              Whish's portal) → book it, never pay the payer twice.
   *   3. REFUND — the Whish call.
   *   4. BOOK  — only once Whish confirms: its `status:true`, or, when it refused
   *              or could not answer, a status check reading `refunded`.
   * A refusal the status check confirms (`success`) releases the lock so the
   * operator can retry. An outcome nobody can confirm keeps the lock and flags
   * the payment; Refresh books it once Whish confirms (refreshPaidPayment).
   *
   * Booking is the admin Reverse: the net comes back out of the company's
   * wallet (a shortfall becomes a RECEIVABLE), both fees are returned, and the
   * company's CRM gets `transaction.reversed`.
   */
  async refundPayment(
    id: string,
    args: { actorId: string; reason: string },
  ): Promise<WhishPaymentResponse> {
    const payment = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUnique({ where: { id } }),
    );
    if (!payment) throw new NotFoundError('WhishPayment', id);
    // Already refunded (a stale dialog, a retried request): nothing to send.
    if (payment.status === WhishPaymentStatus.REFUNDED) return mapWhishPayment(payment);
    if (payment.status !== WhishPaymentStatus.PAID || !payment.transactionId) {
      throw new ConflictError(
        `Only a paid payment can be refunded — this one is ${payment.status}.`,
      );
    }
    if (payment.refundRequestedAt) throw new ConflictError(REFUND_ALREADY_SENT);

    // 1. LOCK. Guarded on PAID + no request: of two concurrent clicks exactly
    //    one passes, and the other is refused without calling Whish.
    const locked = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id, status: WhishPaymentStatus.PAID, refundRequestedAt: null },
        data: {
          refundRequestedAt: new Date(),
          metadata: mergeMetadata(payment.metadata, {
            refundReason: args.reason,
            refundRequestedBy: args.actorId,
          }),
        },
      }),
    );
    if (locked.count !== 1) throw new ConflictError(REFUND_ALREADY_SENT);

    const currency = payment.currency.trim();
    const externalId = payment.externalId.toString();

    // 2. CHECK. Nothing has been sent yet, so any way out of here releases.
    let collectStatus: WhishCollectStatus;
    try {
      ({ collectStatus } = await this.whish.getStatus({ currency, externalId }));
    } catch (err) {
      await this.releaseRefund(payment.id);
      throw err;
    }
    if (collectStatus === 'refunded') {
      this.logger.warn(
        `Whish payment ${externalId} was already refunded at Whish — booking it without asking Whish again.`,
      );
      return this.bookConfirmedRefund(payment, args.actorId);
    }
    if (collectStatus !== 'success') {
      await this.releaseRefund(payment.id);
      throw new ConflictError(
        `Whish reports this payment as '${collectStatus}', not paid, so it cannot be refunded.`,
      );
    }

    // 3. REFUND. The platform's Whish balance is read just before and just after,
    // so the super-admin log shows exactly what Whish took out of the account for
    // this refund — the full amount, or the amount minus the collection fee Whish
    // kept when the customer paid. That is how we learn whether Whish returns its
    // fee on a refund. Best effort: a failed read never blocks the refund.
    const request = { currency, externalId, refundReason: args.reason };
    const balanceBefore = await this.readBalanceForLog(currency);
    let alreadyProcessed = false;
    try {
      ({ alreadyProcessed } = await this.whish.refund(request));
    } catch (err) {
      // After a failed or unanswered call the balance also shows whether the
      // money left anyway.
      this.logRefund(payment, request, err, {
        before: balanceBefore,
        after: await this.readBalanceForLog(currency),
      });
      return this.resolveUnconfirmedRefund(payment, args.actorId, err);
    }
    this.logger.log(
      `Whish refunded payment ${externalId} (${payment.amount.toString()} ${currency}, company ${payment.companyId})` +
        `${alreadyProcessed ? ' — a replay: Whish had already processed this refund' : ''} — booking it.`,
    );

    // 4. BOOK — straight away; the after-balance for the log is read once the
    // booking is done (it doesn't touch the Whish balance), so a slow balance
    // call never widens the gap between Whish paying and our ledger booking.
    try {
      return await this.bookConfirmedRefund(payment, args.actorId);
    } finally {
      this.logRefund(
        payment,
        request,
        null,
        { before: balanceBefore, after: await this.readBalanceForLog(currency) },
        alreadyProcessed,
      );
    }
  }

  /**
   * The refund call failed. Whish either refused it or could not report an
   * outcome — and a lost reply can hide a refund that went through, so Whish's
   * status check decides. Throws unless the refund turns out to have happened.
   */
  private async resolveUnconfirmedRefund(
    payment: WhishPayment,
    actorId: string,
    err: unknown,
  ): Promise<WhishPaymentResponse> {
    // Not a Whish error: thrown before any request left (e.g. Whish is not
    // configured), so nothing was sent.
    if (!(err instanceof WhishError)) {
      await this.releaseRefund(payment.id);
      throw err;
    }
    let collectStatus: WhishCollectStatus | null = null;
    try {
      ({ collectStatus } = await this.whish.getStatus({
        currency: payment.currency.trim(),
        externalId: payment.externalId.toString(),
      }));
    } catch (statusErr) {
      this.logger.warn(
        `Whish status check after a failed refund of ${payment.externalId} also failed: ` +
          `${statusErr instanceof Error ? statusErr.message : 'unknown'}`,
      );
    }
    if (collectStatus === 'refunded') return this.bookConfirmedRefund(payment, actorId);

    const indeterminate = err instanceof WhishIndeterminateError;
    if (collectStatus === 'success' && !indeterminate) {
      // A refusal Whish's own status confirms: nothing left the account.
      await this.releaseRefund(payment.id);
      throw err;
    }

    // Unknown: Whish could not answer (it may still refund), or it refused and
    // we could not double-check. Keep the lock — a second refund must not be
    // sent on a guess — and flag it; Refresh settles it either way.
    await this.flagRefund(payment.id, REFUND_UNCONFIRMED);
    this.logger.error(
      `Whish refund of ${payment.externalId} is UNCONFIRMED (company ${payment.companyId}): ${err.message}. ` +
        `Nothing booked; the refund request is kept and flagged — Refresh books or releases it.`,
    );
    throw new WhishIndeterminateError(
      indeterminate
        ? 'Whish could not confirm the refund — it may still go through. Nothing was booked yet. Press Refresh to check with Whish; the refund is booked as soon as Whish confirms it.'
        : `Whish refused the refund (${err.message}), but its status could not be double-checked. Nothing was booked. Press Refresh to check with Whish.`,
      { externalId: payment.externalId.toString(), paymentId: payment.id },
      err.upstreamResponse,
    );
  }

  /**
   * Book a refund Whish has confirmed. Whish has ALREADY paid the payer, so a
   * failure here must not lose that: the lock stays (nothing can send a second
   * refund) and the payment is flagged — Refresh sees `refunded` plus our
   * request and books it.
   */
  private async bookConfirmedRefund(
    payment: WhishPayment,
    actorId: string,
  ): Promise<WhishPaymentResponse> {
    try {
      return await this.bookRefund(payment.id, actorId);
    } catch (err) {
      this.logger.error(
        `Whish refunded payment ${payment.externalId} but booking it FAILED (company ${payment.companyId}): ` +
          `${err instanceof Error ? err.message : 'unknown'} — flagged; Refresh books it.`,
      );
      await this.flagRefund(payment.id, REFUNDED_NOT_BOOKED).catch((flagErr) =>
        this.logger.warn(
          `Could not flag the unbooked refund of ${payment.externalId}: ${(flagErr as Error).message}`,
        ),
      );
      throw err;
    }
  }

  /**
   * Reverse the settled deposit and mark the payment REFUNDED. Idempotent on
   * both steps: reverse() replays a deposit that is already REVERSED (by an
   * operator, or by an earlier attempt that stopped before the second step), so
   * the company is never clawed back twice; the status flip is guarded on PAID.
   */
  private async bookRefund(id: string, actorId: string): Promise<WhishPaymentResponse> {
    const payment = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id } }),
    );
    if (payment.status === WhishPaymentStatus.REFUNDED) return mapWhishPayment(payment);
    if (payment.status !== WhishPaymentStatus.PAID || !payment.transactionId) {
      throw new ConflictError(`Cannot book a refund for a payment that is ${payment.status}.`);
    }
    const reason =
      (payment.metadata as { refundReason?: unknown } | null)?.refundReason ?? 'no reason recorded';
    // One moment for both records: the deposit's refund (written with its
    // reversal, so the CRM event already says `refunded`) and the payment's.
    const refundedAt = new Date();
    await this.transactions.reverse(payment.transactionId, {
      actorId,
      reason: `Refunded to the payer through Whish: ${String(reason)}`,
      refundedAt,
    });
    const res = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id, status: WhishPaymentStatus.PAID },
        data: {
          status: WhishPaymentStatus.REFUNDED,
          refundedAt,
          metadata: withoutRefundFlags(payment.metadata),
        },
      }),
    );
    const updated = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id } }),
    );
    if (res.count === 1) {
      this.logger.log(
        `Whish payment ${payment.externalId} REFUNDED — transaction ${payment.transactionId} reversed (company ${payment.companyId})`,
      );
      // reverse() already refreshed transactions/wallets/ledger and told the CRM.
      this.realtime.company(payment.companyId, ['whish']);
    }
    return mapWhishPayment(updated);
  }

  /** Mark a refund request as needing an operator (the lock is kept). */
  private async flagRefund(id: string, message: string): Promise<void> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id } }),
    );
    await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id, status: WhishPaymentStatus.PAID },
        data: {
          metadata: mergeMetadata(row.metadata, {
            needsAttention: true,
            refundUnconfirmed: true,
            settlementError: message,
          }),
        },
      }),
    );
    this.realtime.company(row.companyId, ['whish']);
  }

  /** Drop a refund request that did not (and will not) happen, so it can be retried. */
  private async releaseRefund(id: string): Promise<WhishPaymentResponse> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id } }),
    );
    const res = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id, status: WhishPaymentStatus.PAID, refundRequestedAt: { not: null } },
        data: { refundRequestedAt: null, metadata: withoutRefundRequest(row.metadata) },
      }),
    );
    if (res.count === 1) this.realtime.company(row.companyId, ['whish']);
    const current = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id } }),
    );
    return mapWhishPayment(current);
  }

  /** Super-admin log: the refund we asked Whish for, and what Whish returned. */
  private logRefund(
    payment: WhishPayment,
    request: { currency: string; externalId: string; refundReason: string },
    err: unknown,
    balance: { before: string | null; after: string | null },
    // Whish's `retrieved` flag: it had already processed this refund (a replay).
    alreadyProcessed = false,
  ): void {
    const details = err instanceof WhishError ? err.details : undefined;
    // What left the platform's Whish account across the call (another payment
    // landing in the same second would show here too). null when either read
    // failed.
    const platformBalance = {
      before: balance.before,
      after: balance.after,
      change:
        balance.before !== null && balance.after !== null
          ? Money.of(balance.after).sub(Money.of(balance.before)).toFixed(2)
          : null,
    };
    this.txLogs.record({
      kind: 'WHISH_REFUND',
      companyId: payment.companyId,
      sourceCode: WHISH_SOURCE_CODE,
      reference: request.externalId,
      transactionId: payment.transactionId,
      statusCode: err ? (typeof details?.httpStatus === 'number' ? details.httpStatus : 502) : 200,
      success: !err,
      request,
      response: err
        ? {
            code: err instanceof WhishError ? err.code : 'WHISH_ERROR',
            message: err instanceof Error ? err.message : 'unknown',
            upstream:
              (err instanceof WhishError ? err.upstreamResponse : undefined) ??
              details?.upstreamMessage ??
              null,
            indeterminate: err instanceof WhishIndeterminateError,
            platformBalance,
          }
        : { status: true, retrieved: alreadyProcessed, platformBalance },
    });
  }

  /** The platform's Whish balance as a decimal string, or null if it can't be read. */
  private async readBalanceForLog(currency: string): Promise<string | null> {
    if (!(WHISH_CURRENCIES as readonly string[]).includes(currency)) return null;
    try {
      const { balance } = await this.whish.getBalance(currency as WhishCurrency);
      return Money.of(String(balance)).toFixed(2);
    } catch (err) {
      this.logger.warn(
        `Could not read the Whish balance for the refund log: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return null;
    }
  }

  /** Admin: fetch one payment by id across companies (e.g. an audit-log deep link). */
  async adminGetById(id: string): Promise<WhishPaymentResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.whishPayment.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('WhishPayment', id);
    return mapWhishPayment(row);
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
   * Remember the last NOT-settled status Whish reported, so the poller can tell
   * "the customer simply never paid" (`pending`, closed at EXPIRE_AGE_MS) from
   * "Whish could not tell us whether it collected" (`unknown`, asked about until
   * UNKNOWN_EXPIRE_AGE_MS). Only writes when the value actually changes, so
   * repeated checks cost no extra writes. Never touches `needsAttention` — that
   * would stop the poller from re-checking it.
   */
  private async noteLastCollectStatus(
    payment: WhishPayment,
    collectStatus: 'pending' | 'unknown',
  ): Promise<WhishPaymentResponse> {
    const meta = payment.metadata as { lastCollectStatus?: string } | null;
    if (meta?.lastCollectStatus === collectStatus) return mapWhishPayment(payment);
    // Guarded on still-PENDING like every other write on this path: `payment` is
    // a snapshot, and a concurrent success callback may have settled the row in
    // the meantime. An unguarded update would stamp stale metadata (potentially a
    // resurrected needsAttention) onto a PAID payment.
    await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id: payment.id, status: WhishPaymentStatus.PENDING },
        data: { metadata: mergeMetadata(payment.metadata, { lastCollectStatus: collectStatus }) },
      }),
    );
    const current = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id: payment.id } }),
    );
    return mapWhishPayment(current);
  }

  /**
   * Close a link as a settled NON-collection — Whish reported either `failed`
   * (the link expired unpaid, or the attempt was declined and the link has since
   * lapsed) or `refunded` (a successful payment was refunded). Both mean the
   * money is not ours, and both surface to the company as `transaction.failed`;
   * the exact upstream status is kept in metadata so ops can tell them apart.
   */
  private async closeAsNotCollected(
    payment: WhishPayment,
    collectStatus: 'failed' | 'refunded',
    currency: string,
    payerPhoneNumber: string | null,
    // False for a link the company was never told about (no
    // `transaction.pending`, no reference in an answer): closing it must not
    // send its CRM an event for a reference it has never seen.
    tellCrm = true,
  ): Promise<WhishPaymentResponse> {
    // Guard on still-PENDING: a delayed 'failed' status from Whish must never
    // overwrite a payment a concurrent callback/settle already moved to PAID.
    const res = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.updateMany({
        where: { id: payment.id, status: WhishPaymentStatus.PENDING },
        data: {
          status: WhishPaymentStatus.FAILED,
          payerPhoneNumber,
          metadata: mergeMetadata(payment.metadata, { collectStatus }),
        },
      }),
    );
    const current = await this.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id: payment.id } }),
    );
    if (res.count === 1) {
      this.logger.log(`Whish payment ${payment.externalId} closed as ${collectStatus}`);
      this.realtime.company(payment.companyId, ['whish']);
      if (tellCrm) {
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
    }
    return mapWhishPayment(current);
  }

  /**
   * Authoritative settlement: ask Whish for the real collect status and act on
   * it. Idempotent — a PAID payment is left alone, and settlement re-uses the
   * existing ingest path whose (source, externalId) unique constraint prevents
   * a double credit if this runs twice.
   */
  private async reconcile(payment: WhishPayment): Promise<WhishPaymentResponse> {
    if (
      payment.status === WhishPaymentStatus.PAID ||
      payment.status === WhishPaymentStatus.REFUNDED
    ) {
      return mapWhishPayment(payment);
    }

    const currency = payment.currency.trim();
    let collectStatus: WhishCollectStatus;
    let payerPhoneNumber: string | null;
    try {
      ({ collectStatus, payerPhoneNumber } = await this.whish.getStatus({
        currency,
        externalId: payment.externalId.toString(),
      }));
    } catch (err) {
      // `external_id.not_exists` on a LINKLESS ORPHAN is the definitive answer we
      // were waiting for: the create was indeterminate, and Whish is now telling
      // us it never minted that id. Close it out instead of re-throwing every
      // tick forever — the timeout backstop sits after this call, so a row that
      // always throws here would otherwise never expire.
      //
      // Guarded hard on collectUrl === null. The same code on a row that DOES
      // have a link means Whish lost a payment we know exists — an operator case,
      // never a silent close.
      const code = err instanceof WhishError ? err.details?.code : undefined;
      if (code === 'external_id.not_exists' && isLinklessOrphan(payment)) {
        // After an INDETERMINATE create the company got the reference and a
        // `transaction.pending`, so it is told the outcome. A row our own
        // failure left before Whish was called was answered with an error and
        // no reference: it is closed without a word to the CRM.
        const announced =
          (payment.metadata as { linkCreateIndeterminate?: boolean } | null)
            ?.linkCreateIndeterminate === true;
        this.logger.warn(
          `Whish payment ${payment.externalId} was never minted (external_id.not_exists, ` +
            `${announced ? 'after an indeterminate create' : 'create failed before Whish answered'}) — closing it out.`,
        );
        return this.closeAsNotCollected(payment, 'failed', currency, null, announced);
      }
      throw err;
    }

    // Whish Pay v1.4.4 collect statuses. Only 'success' and 'failed' are SETTLED
    // outcomes; 'pending' and 'unknown' both mean "not settled yet, keep polling".
    switch (collectStatus) {
      case 'pending':
        // Stays payable even AFTER a failed attempt (v1.4.4 is explicit: "a
        // failure callback is not the end of the payment"), so this is not a
        // settled outcome. Leave the row PENDING and keep polling —
        // EXPIRE_AGE_MS is the backstop.
        return this.noteLastCollectStatus(payment, 'pending');

      case 'unknown':
        // Whish could not determine the final state — it may or may not have
        // collected. Also not settled, so keep polling exactly like 'pending'.
        // Deliberately NOT flagged needsAttention: the poller SKIPS flagged rows,
        // which would freeze the payment instead of resolving it. The status is
        // recorded so the poller keeps asking past the unpaid-link cutoff, and
        // closes a link still unresolved at UNKNOWN_EXPIRE_AGE_MS as an operator
        // case rather than a silent lapse.
        return this.noteLastCollectStatus(payment, 'unknown');

      case 'failed':
      case 'refunded':
        // Settled non-collection: the money is not (or is no longer) ours.
        return this.closeAsNotCollected(payment, collectStatus, currency, payerPhoneNumber);

      case 'success':
        break; // falls through to the credit path below

      default: {
        // Unreachable by type — the client rejects any status outside the five
        // documented values. Runtime backstop only: an UNRECOGNIZED status must
        // NEVER fall through to the credit path. Treat it like paid-but-unsettled:
        // log, flag for an operator, leave PENDING, and do NOT touch the ledger.
        const unrecognized: string = collectStatus;
        this.logger.error(
          `Whish payment ${payment.externalId} returned unexpected collectStatus '${unrecognized}' ` +
            `(company ${payment.companyId}) — NOT crediting; flagging for operator and leaving PENDING for retry.`,
        );
        const flagged = await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.update({
            where: { id: payment.id },
            // NOTE the key: `unrecognizedCollectStatus`, not `unknownStatus`.
            // 'unknown' is now a RECOGNISED Whish value handled above and must
            // stay pollable; this flag is for a value we have never seen, and it
            // sets needsAttention (which the poller skips) on purpose.
            data: {
              metadata: mergeMetadata(payment.metadata, {
                needsAttention: true,
                unrecognizedCollectStatus: unrecognized,
              }),
            },
          }),
        );
        this.realtime.company(payment.companyId, ['whish']);
        return mapWhishPayment(flagged);
      }
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
          data: {
            metadata: mergeMetadata(before.metadata, {
              needsAttention: true,
              paidAfterExpiry: true,
            }),
          },
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
            // Lift the payer phone + invoice to the TOP LEVEL so mapTxRow surfaces
            // them on the settled TransactionResponse AND the transaction.completed
            // CRM event — matching the transaction.pending event (emitWhish), which
            // already carries them. Without this the COMPLETED event (which upserts
            // the same whish:<externalId> record) would blank them back to null.
            ...(payerPhoneNumber ? { phone: payerPhoneNumber } : {}),
            ...(payment.invoice ? { note: payment.invoice } : {}),
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
        // Genuine failure: Whish has the customer's money but we can't settle it.
        // NEVER let collected money sit invisibly stuck — but distinguish WHY:
        //  - PERMANENT (DomainError, e.g. NO_COMMISSION_RULE or a deactivated
        //    company): retrying every 60s can't fix config → park as
        //    needsAttention immediately (the poller
        //    skips parked rows; the admin Refresh recovers once config is fixed).
        //  - TRANSIENT (DB blip, exhausted serializable retries, anything else):
        //    the next poller tick will likely succeed → leave it in the retry set
        //    (no needsAttention), only parking after TRANSIENT_SETTLE_PARK_AFTER
        //    consecutive failures so a persistent unknown failure still reaches an
        //    operator instead of retrying forever.
        const message = err instanceof Error ? err.message : 'settlement failed';
        const isPermanent = err instanceof DomainError;
        const priorAttempts =
          ((payment.metadata as { settlementAttempts?: number } | null)?.settlementAttempts ?? 0) +
          1;
        const park = isPermanent || priorAttempts >= TRANSIENT_SETTLE_PARK_AFTER;
        this.logger.error(
          `Whish payment ${payment.externalId} is PAID at Whish but could NOT be settled (company ${payment.companyId}): ${message}. ` +
            (park
              ? 'Parked as needsAttention — operator action required (admin Refresh re-settles once the cause is fixed).'
              : `Left PENDING for automatic retry (attempt ${priorAttempts}/${TRANSIENT_SETTLE_PARK_AFTER}).`),
        );
        // Company-facing: only surface intentional DomainError messages
        // (actionable + safe). An unexpected internal error
        // (Prisma, etc.) must not leak schema/internal detail into the company's
        // response — the raw message stays in the log above for operators.
        const safeError = isPermanent ? err.message : 'Settlement failed — please contact support.';
        await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.update({
            where: { id: payment.id },
            data: {
              // Merged: an already-parked row that hits a transient blip on an
              // admin Refresh must not lose its needsAttention/settlementError
              // and silently rejoin the poller.
              metadata: mergeMetadata(
                payment.metadata,
                park
                  ? { needsAttention: true, paidButUnsettled: true, settlementError: safeError }
                  : { paidButUnsettled: true, settlementAttempts: priorAttempts },
              ),
              // Left for automatic retry: due at the poller's next run, whoever
              // asked (callback, a company's refresh, the poller) and however
              // young the link is.
              ...(park ? {} : { nextPollAt: new Date() }),
            },
          }),
        );
        if (park) this.realtime.company(payment.companyId, ['whish']);
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
            metadata: mergeMetadata(updated.metadata, {
              needsAttention: true,
              paidAfterExpiry: true,
            }),
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
   * Background reconciliation: ask Whish about PENDING links that are past
   * their payable window (the link expired unpaid, or a callback was missed),
   * and close the ones Whish never resolves (→ FAILED, since Whish has no
   * "expired" status to distinguish a lapse from a decline).
   * No-op when Whish isn't configured. Returns a small summary for logging.
   */
  async reconcileStalePayments(opts?: {
    /** Per-tick bound (default RECONCILE_MAX_PER_TICK); tests use a small one. */
    limit?: number;
    /**
     * Shutdown: once true, no further link is started — a link being checked
     * finishes (each check is whole on its own), the rest wait for the next
     * instance's run. A run can take minutes (250 links, Whish calls of up to
     * 10s), and a deploy must not wait for that.
     */
    shouldStop?: () => boolean;
  }): Promise<{ checked: number; timedOut: number; more: boolean; throttled: boolean }> {
    if (!this.whish.isConfigured()) {
      return { checked: 0, timedOut: 0, more: false, throttled: false };
    }

    const now = Date.now();
    const limit = opts?.limit ?? RECONCILE_MAX_PER_TICK;
    // The links due now, earliest-due first. Every link is on the schedule from
    // birth (next_poll_at; a row without one is due at once), and the
    // PENDING-only index is in schedule order — so this takes the HEAD of the
    // schedule and keeps what is due, reading at most `limit` rows however many
    // links are open. Measured with 500,000 payable links: 250 rows, 0.3 ms.
    // Asking for "the due rows" directly read all 500,000 on every run: the
    // row-security barrier keeps a condition on the COALESCE out of the index
    // scan, so only the LIMIT can stop it.
    //
    // Paid-but-unsettled rows (needsAttention) are excluded HERE, in the SQL, so
    // they can never take a slot: Whish HAS the customer's money but we couldn't
    // book it (e.g. its commission rule changed) — they wait for an operator,
    // not for re-polling. `IS DISTINCT FROM` keeps every row whose metadata is
    // NULL or lacks the flag — which is every normal pending payment. (A Prisma
    // `NOT (metadata path = true)` silently drops those rows; that bug once kept
    // the poller from selecting anything.)
    const due = await this.prisma.runAsAdmin(
      (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM (
          SELECT id, COALESCE(next_poll_at, created_at) AS due_at
          FROM whish_payments
          WHERE status = 'PENDING'
            AND (metadata->>'needsAttention') IS DISTINCT FROM 'true'
          ORDER BY COALESCE(next_poll_at, created_at)
          LIMIT ${limit}
        ) head
        WHERE due_at <= ${new Date(now)}
        ORDER BY due_at`,
    );
    // A full batch: more links may be due. The caller runs again at once,
    // earliest-due first, instead of leaving them for the next heartbeat.
    const more = due.length === limit;
    if (more) {
      this.logger.warn(
        `Reconciliation took a full batch of ${limit} due links; the next run follows at once.`,
      );
    }
    const fetched = due.length
      ? await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.findMany({ where: { id: { in: due.map((d) => d.id) } } }),
        )
      : [];
    const byId = new Map(fetched.map((r) => [r.id, r]));
    const rows = due.map((d) => byId.get(d.id)).filter((r): r is WhishPayment => Boolean(r));

    let timedOut = 0;
    let cursor = 0;
    let checked = 0;
    // Set when Whish answers "too many requests": no further link is started,
    // and the caller waits for its next every-minute pass. Whish documents no
    // rate limit, and the account is the one every company's link creation
    // goes through — so at the first sign the poller is the one that yields.
    const run = { throttled: false };
    const worker = async (): Promise<void> => {
      while (cursor < rows.length && !run.throttled && !opts?.shouldStop?.()) {
        const p = rows[cursor++]!;
        checked++;
        if (await this.pollStaleLink(p, now, run)) timedOut++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RECONCILE_CONCURRENCY, rows.length) }, () => worker()),
    );
    if (run.throttled) {
      this.logger.warn(
        `Whish answered "too many requests" to a status check: reconciliation stopped after ` +
          `${checked} link(s) and waits for its next every-minute pass; the rest stay due.`,
      );
    }
    return { checked, timedOut, more, throttled: run.throttled };
  }

  /**
   * When the next link is due for a check — in the past if one is waiting, null
   * when no link is open. One row off the head of the schedule (0.07 ms with
   * 500,000 open links); the poller uses it to come back at that moment.
   */
  async nextPollDueAt(): Promise<number | null> {
    if (!this.whish.isConfigured()) return null;
    const rows = await this.prisma.runAsAdmin(
      (tx) =>
        tx.$queryRaw<Array<{ due_at: Date }>>`
        SELECT COALESCE(next_poll_at, created_at) AS due_at
        FROM whish_payments
        WHERE status = 'PENDING'
          AND (metadata->>'needsAttention') IS DISTINCT FROM 'true'
        ORDER BY COALESCE(next_poll_at, created_at)
        LIMIT 1`,
    );
    return rows[0]?.due_at.getTime() ?? null;
  }

  /**
   * One poller check of a due PENDING link: ask Whish, settle or close it, or —
   * if it is still unresolved — schedule its next check. Resolves `true` when
   * the cutoff closed it. Never throws.
   */
  private async pollStaleLink(
    p: WhishPayment,
    now: number,
    run: { throttled: boolean },
  ): Promise<boolean> {
    // Defence in depth: the selection already excludes flagged rows, but one
    // may have been flagged between that query and this check.
    if ((p.metadata as { needsAttention?: boolean } | null)?.needsAttention === true) return false;
    let timedOut = false;
    const ageMs = now - p.createdAt.getTime();
    const tooOld = ageMs > EXPIRE_AGE_MS;
    try {
      // Always ask Whish for the authoritative status first — never time out a
      // payment that actually settled just before the cutoff.
      //
      // INVARIANT: the timeout below MUST stay inside this try and AFTER
      // reconcile(). An indeterminate upstream (v1.4.4 code:500 / timeout /
      // 5xx) throws, skipping the timeout entirely — so we never expire a link
      // whose status we could not read. Moving the timeout out of the try would
      // silently start failing payments on an upstream blip.
      const result = await this.reconcile(p);
      // Whish reports success | failed | pending | refunded | unknown — it has
      // NO "expired" status, so we can't tell a decline from a lapsed link. A
      // link still PENDING past our cutoff is one Whish never resolved (either
      // still 'pending' — it stays payable even after a failed attempt — or
      // 'unknown'); we collapse it into the same terminal as a Whish 'failed'
      // (one non-success signal for the CRM). Never do this to a
      // paid-but-unsettled link (needsAttention): Whish HAS the money but we
      // couldn't book it — that needs an operator, not a silent fail.
      if (tooOld && result.status === WhishPaymentStatus.PENDING && !result.needsAttention) {
        // A link whose LAST reading was 'unknown' is not the same as one the
        // customer simply never paid: Whish told us it could not determine
        // whether it collected, so it may be holding the money. It is asked
        // about for much longer, and then still closed (nothing pends forever)
        // but flagged, so it lands in the operator queue instead of quietly
        // becoming a lapse.
        // Re-read: reconcile() just wrote lastCollectStatus, so `p` is stale.
        // Everything below merges onto THIS value, not the stale snapshot.
        const fresh = await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.findUnique({ where: { id: p.id }, select: { metadata: true } }),
        );
        const freshMeta = fresh?.metadata ?? null;
        const indeterminate =
          (freshMeta as { lastCollectStatus?: string } | null)?.lastCollectStatus === 'unknown';
        if (indeterminate && ageMs <= UNKNOWN_EXPIRE_AGE_MS) {
          await this.scheduleNextPoll(p.id, now + nextPollDelayMs(ageMs));
          return false;
        }

        // Guard on the row STILL being PENDING. reconcile() acted on a stale
        // snapshot; a success callback may have settled it to PAID meanwhile.
        // Without the status guard we'd overwrite a real PAID payment — a
        // self-contradictory, corrupt record.
        const res = await this.prisma.runAsAdmin((tx) =>
          tx.whishPayment.updateMany({
            where: { id: p.id, status: WhishPaymentStatus.PENDING },
            data: {
              status: WhishPaymentStatus.FAILED,
              ...(indeterminate
                ? {
                    metadata: mergeMetadata(freshMeta, {
                      needsAttention: true,
                      closedFromUnknown: true,
                      settlementError:
                        'Whish never resolved this link (last status: unknown) — verify with Whish whether it collected before treating it as failed.',
                    }),
                  }
                : {}),
            },
          }),
        );
        if (res.count === 1) {
          if (indeterminate) {
            this.logger.error(
              `Whish payment ${p.externalId} timed out while its status was UNKNOWN (company ${p.companyId}) — ` +
                `closed FAILED and flagged for an operator; Whish may have collected.`,
            );
          }
          this.realtime.company(p.companyId, ['whish']);
          this.crm.emitWhish({
            companyId: p.companyId,
            externalId: p.externalId,
            amount: p.amount.toString(),
            currency: p.currency.trim(),
            invoice: p.invoice,
            event: 'transaction.failed',
          });
          timedOut = true;
        }
      } else if (result.status === WhishPaymentStatus.PENDING && !result.needsAttention) {
        // Still unresolved: the next check, paced by the link's age.
        await this.scheduleNextPoll(p.id, now + nextPollDelayMs(ageMs));
      }
    } catch (err) {
      // Couldn't reach Whish (or Whish has the money and booking it failed) —
      // leave it PENDING and retry next run rather than blindly expiring a
      // possibly-paid payment. Retried every minute whatever the link's age (it
      // may be a paid deposit waiting to be booked), behind the links already
      // due, so a link Whish keeps erroring on can never hold the head of the
      // queue.
      this.logger.warn(`Reconcile failed for payment ${p.externalId}: ${(err as Error).message}`);
      if (err instanceof WhishError && err.details?.httpStatus === 429) run.throttled = true;
      await this.scheduleNextPoll(p.id, now + 60_000);
    }
    return timedOut;
  }

  /** Set when the poller next checks a still-PENDING link. Best-effort. */
  private async scheduleNextPoll(id: string, at: number): Promise<void> {
    await this.prisma
      .runAsAdmin((tx) =>
        tx.whishPayment.updateMany({
          // Guarded like every write here: a callback may have settled it meanwhile.
          where: { id, status: WhishPaymentStatus.PENDING },
          data: { nextPollAt: new Date(at) },
        }),
      )
      .catch((err) =>
        this.logger.warn(
          `Could not schedule the next Whish poll for ${id}: ${(err as Error).message}`,
        ),
      );
  }

  /** Admin: list Whish payments across all companies. */
  async listAll(query: ListWhishPaymentsQuery): Promise<PaginatedResponse<WhishPaymentResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where = this.listWhere(query, {});
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

  /**
   * Stream ALL Whish payments matching the filters as CSV (no row cap), walked in
   * keyset chunks over (createdAt desc, id desc). Mirrors the list query's filters
   * so the export matches exactly what the user sees. A company scope (companyId)
   * runs each chunk under RLS; the admin export (no companyId) runs cross-company.
   */
  streamCsv(args: {
    companyId?: string;
    query: ListWhishPaymentsQuery;
    /** Back office never reads a settlement failure reason — see common/backoffice-view.ts. */
    backoffice?: boolean;
  }): StreamableFile {
    const where = this.listWhere(args.query, { companyId: args.companyId });
    const scope = args.companyId ?? null;
    const prisma = this.prisma;
    return streamCsvKeyset<WhishPayment>({
      filename: `whish-payments-${Date.now()}.csv`,
      header: WHISH_CSV_HEADER,
      fetchPage: (cursor, take) => {
        // Combine the base filter with the keyset predicate via AND — a plain
        // top-level OR here would CLOBBER the search OR the base `where` may set.
        const pageWhere: Prisma.WhishPaymentWhereInput = cursor
          ? {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : where;
        return prisma.runAsScoped(scope, (tx) =>
          tx.whishPayment.findMany({
            where: pageWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        );
      },
      cursorOf: (r) => ({ createdAt: r.createdAt, id: r.id }),
      toCells: args.backoffice ? (row) => whishCsvCells(row, { backoffice: true }) : whishCsvCells,
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

// CSV columns for the Whish Pay export. A Whish collect is a single settled
// amount (the payer pays it in full — there's no fee/net split at this layer, so
// no gross/net ambiguity like the money-out flows). `reference` is the numeric
// externalId shown as #<n> in the app; `needs_attention` / `settlement_error`
// surface the paid-but-unsettled state.
const WHISH_CSV_HEADER = [
  'id',
  'created_at',
  'paid_at',
  'reference',
  'company_id',
  'status',
  'currency',
  'amount',
  'invoice',
  'payer_phone',
  'transaction_id',
  'needs_attention',
  'settlement_error',
  'collect_url',
] as const;

function whishCsvCells(
  row: WhishPayment,
  viewer: { backoffice: boolean } = { backoffice: false },
): Array<string | null> {
  const meta =
    (row.metadata as { needsAttention?: unknown; settlementError?: unknown } | null) ?? null;
  const settlementError = typeof meta?.settlementError === 'string' ? meta.settlementError : '';
  return [
    row.id,
    row.createdAt.toISOString(),
    row.paidAt?.toISOString() ?? '',
    row.externalId.toString(),
    row.companyId,
    row.status,
    row.currency.trim(),
    Money.fromDb(row.amount).toFixed(2),
    row.invoice,
    row.payerPhoneNumber ?? '',
    row.transactionId ?? '',
    meta?.needsAttention === true ? 'true' : 'false',
    // The reason can spell out a price; back office only learns that one exists.
    viewer.backoffice && settlementError !== '' ? BACKOFFICE_SETTLEMENT_ERROR : settlementError,
    row.collectUrl ?? '',
  ];
}

/** Append `ref=<externalId>` to a redirect URL, respecting any existing query. */
/**
 * A PENDING payment whose link was never confirmed minted, so it has no
 * collectUrl: either the create call to Whish came back INDETERMINATE (flagged
 * linkCreateIndeterminate), or the create failed on OUR side after the row was
 * saved and before Whish answered (e.g. the database was too busy to give a
 * connection) — no flag can be written then. It is not payable as-is, so an
 * idempotent retry must re-attempt the mint rather than hand the same dead row
 * back, and the poller closes it once Whish says it never made it.
 *
 * Without the flag, only once it is older than MINT_IN_FLIGHT_MS: a younger
 * row may be a create that is still waiting for Whish (its call times out in
 * 10s), which must not be minted twice.
 */
/**
 * Reusing an idempotency key with a DIFFERENT body is a client bug, and on the
 * orphan-retry path it is a dangerous one: we would mint a Whish link for the
 * new amount while settlement still credits the amount stored on the row. Fail
 * loudly instead of silently picking one of the two.
 */
function assertRetryMatchesRow(row: WhishPayment, input: CreateWhishPaymentInput): void {
  const changed =
    // fromDb on the row side: input.amount is already quantized by the schema,
    // so comparing it against a RAW legacy value would reject an honest retry.
    !Money.fromDb(row.amount).eq(Money.of(input.amount)) ||
    row.currency !== input.currency ||
    row.invoice !== input.invoice;
  if (changed) {
    throw new ValidationError(
      'idempotencyKey was already used for a different payment (amount, currency or invoice differs). ' +
        'Retry with the original body to recover that payment, or use a new idempotencyKey.',
      { externalId: row.externalId.toString(), paymentId: row.id },
    );
  }
}

function isLinklessOrphan(row: WhishPayment): boolean {
  return (
    row.status === WhishPaymentStatus.PENDING &&
    row.collectUrl === null &&
    ((row.metadata as { linkCreateIndeterminate?: boolean } | null)?.linkCreateIndeterminate ===
      true ||
      Date.now() - row.createdAt.getTime() > MINT_IN_FLIGHT_MS)
  );
}

/**
 * Merge into the existing metadata rather than replacing it. Prisma's Json
 * update overwrites the whole document, so a plain assignment silently drops
 * markers a previous step wrote (`paidAfterExpiry`, `settlementError`, …) —
 * exactly the breadcrumbs an operator needs when two odd things happened to the
 * same payment.
 */
function mergeMetadata(
  current: WhishPayment['metadata'],
  patch: Record<string, unknown>,
): Prisma.InputJsonValue {
  return { ...metadataObject(current), ...patch } as Prisma.InputJsonValue;
}

/** A copy of the metadata as a plain object ({} when it is null or not an object). */
function metadataObject(current: WhishPayment['metadata']): Record<string, unknown> {
  return current && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
}

/**
 * Metadata once a refund is booked: every operator flag is resolved (the money
 * is back with the payer and the deposit is reversed). The breadcrumbs —
 * refundReason, refundRequestedBy, paidAfterExpiry, refundedAfterSettlement —
 * stay, so the history of the payment is still readable.
 */
function withoutRefundFlags(current: WhishPayment['metadata']): Prisma.InputJsonValue {
  const meta = metadataObject(current);
  delete meta.needsAttention;
  delete meta.settlementError;
  delete meta.refundUnconfirmed;
  return meta as Prisma.InputJsonValue;
}

/**
 * Metadata once a refund request is released (Whish did not refund). Drops what
 * the request wrote. needsAttention/settlementError are only dropped when the
 * refund flag raised them, and needsAttention goes back to the one other case
 * that raises it on a paid row (paid after expiry) — it was there first.
 */
function withoutRefundRequest(current: WhishPayment['metadata']): Prisma.InputJsonValue {
  const meta = metadataObject(current);
  const flaggedByRefund = meta.refundUnconfirmed === true;
  delete meta.refundReason;
  delete meta.refundRequestedBy;
  delete meta.refundUnconfirmed;
  if (flaggedByRefund) {
    delete meta.settlementError;
    if (meta.paidAfterExpiry === true) meta.needsAttention = true;
    else delete meta.needsAttention;
  }
  return meta as Prisma.InputJsonValue;
}

function withRef(base: string, externalId: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ref=${externalId}`;
}

function mapWhishPayment(row: WhishPayment): WhishPaymentResponse {
  const meta =
    (row.metadata as { needsAttention?: unknown; settlementError?: unknown } | null) ?? null;
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
    // The exact reason settlement failed (the thrown ingest error), so the UI can
    // show what actually went wrong instead of guessing "check its commission rule".
    settlementError: typeof meta?.settlementError === 'string' ? meta.settlementError : null,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    refundedAt: row.refundedAt?.toISOString() ?? null,
  };
}
