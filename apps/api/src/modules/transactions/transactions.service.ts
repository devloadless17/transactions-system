import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import {
  Money,
  MONEY_SCALE_LABEL,
  SourceFeeChannel,
  type FeeApplication,
  type IngestCompanyListItem,
  type IngestTransactionInput,
  type ListTransactionsQuery,
  type PaginatedResponse,
  type TransactionResponse,
} from '@app/shared';
import { computeSourceFee } from '../sources/source-fee.compute';
import { Prisma } from '@app/db';
import type { PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CommissionResolverService } from '../commissions/commission-resolver.service';
import { CommissionsRepository } from '../commissions/commissions.repository';
import { LedgerService } from '../ledger/ledger.service';
import {
  moneyInEntries,
  netOfFee,
  reservedTotal,
  reversalEntries,
  type FeeParts,
} from '../ledger/flow-ledger';
import {
  boundDepositNetworkFee,
  computeNetworkFee,
  readNetworkFeeRate,
} from '../commissions/network-fee';
import { WalletsService } from '../wallets/wallets.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CacheService } from '../cache/cache.service';
import { CrmDispatchService } from '../crm/crm-dispatch.service';
import {
  ConflictError,
  DuplicateTransactionError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';
import { csvCell } from '../../common/csv';
import { backofficeCsvCells } from '../../common/backoffice-view';

// The per-tenant list COUNT is cached briefly so paging reuses it and a whale
// tenant's COUNT(*) doesn't re-run on every page load. The total can lag by up
// to this window; the rows themselves are always live. Deliberately NOT
// invalidated on mutation — the short TTL is the tradeoff that avoids per-write
// cache churn.
const LIST_COUNT_CACHE_TTL_SEC = 30;

// CSV export streams rows in keyset chunks: each chunk is a short, RLS-scoped
// query written straight to the HTTP response, so memory stays bounded to a
// single chunk and there is NO row cap — a multi-million-row export completes
// without materializing the whole result set or holding one long DB transaction
// open across the (possibly slow) client download.
const CSV_EXPORT_CHUNK = 1000;

// Offset pagination makes Postgres scan + discard every skipped row, so a very
// deep page (e.g. page 50,000) turns into a half-million-row disk sort per
// request. No human pages that deep through the UI — they filter by date/source
// or export — so we cap the reachable offset and tell the caller to narrow the
// query instead of silently serving a slow scan. Generous enough that no real
// browsing hits it (100k rows at pageSize 100 = page 1,000).
const MAX_LIST_OFFSET = 100_000;

// A pricing gap on ingest no longer blocks the deposit — it books at net 0
// (full amount withheld as fee, `pricing_issue` stamped) — but the company is
// credited NOTHING until an operator fixes the rule and compensates, so we
// alert ops loudly. Re-alert at most once per (kind, company, source) per this
// window so a busy source can't flood the error log.
const NO_RULE_ALERT_TTL_MS = 10 * 60_000;

// Source-fee schedules are admin-only static config that changes rarely, yet the
// fee is priced on EVERY deposit. Without caching, each ingest opens a second
// (RLS-bypassing) DB transaction just to re-read these rows. Cache the rule set
// per (source, channel) for a short window — edits take effect within the TTL,
// and `SourcesService.setFeeRules` busts the `sourcefee` namespace for immediacy.
const SOURCE_FEE_RULE_CACHE_TTL_SEC = 15;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CommissionResolverService,
    private readonly commissionsRepo: CommissionsRepository,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly analytics: AnalyticsService,
    private readonly realtime: RealtimeService,
    @InjectMetric('txn_ingest_total') private readonly ingestCounter: Counter<string>,
    @InjectMetric('txn_ingest_no_rule_total')
    private readonly noRuleCounter: Counter<string>,
    @InjectMetric('txn_ingest_pricing_issue_total')
    private readonly pricingIssueCounter: Counter<string>,
    private readonly cache: CacheService,
    private readonly crm: CrmDispatchService,
  ) {}

  /**
   * Public list of companies for source providers to discover slugs.
   * Called by Wish/OMT/etc on startup so they can cache slugs and then
   * post transactions against them. Returns every ACTIVE + visible company.
   * `visible` is purely a discovery-list filter: it controls whether a company
   * shows up HERE, and nothing else — it does NOT gate ingestion (a source that
   * already knows a hidden-but-active company's slug can still post to it). Only
   * the fields a third-party integrator needs to know are returned.
   *
   * Guarded by `ApiKeyAuthGuard` + source-key check in the controller;
   * the service itself is unauthenticated for testability.
   */
  async listVisibleCompanies(): Promise<{ data: IngestCompanyListItem[] }> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.company.findMany({
        where: {
          status: 'ACTIVE',
          visible: true,
        },
        orderBy: { slug: 'asc' },
        select: { id: true, slug: true, name: true, defaultCurrency: true },
      }),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        defaultCurrency: r.defaultCurrency.trim(),
      })),
    };
  }

  /**
   * Ingest a transaction posted by an external source provider.
   *
   * Atomic, inside one serializable DB transaction:
   *   1. Resolve source by id (from the API key) and target company by id (the
   *      HTTP boundary already resolved the body's companySlug to a UUID)
   *   2. Honour idempotency (explicit key OR natural (source, externalId) pair)
   *   3. Resolve the matching commission rule
   *   4. Insert the `transactions` row with status = COMPLETED
   *   5. Write balanced ledger entries (DEBIT EXTERNAL, CREDIT AVAILABLE, CREDIT FEE)
   *   6. Apply the wallet delta (available += netAmount)
   *   7. Invalidate analytics cache
   */
  async ingest(
    // `channel` classifies the deposit for source-fee pricing: WHISH_PAY when the
    // caller is the Whish collect-link settlement (the whish_payments link isn't
    // attached until after this insert, so it can't be inferred here), else INGEST
    // for a direct ingest-API deposit. Internal-only — never set by external input.
    ctx: {
      kind: 'source';
      sourceId: string;
      channel?: SourceFeeChannel;
      // The HTTP ingest controller has ALREADY resolved + ACTIVE-checked both
      // rows (source by code, company by slug) milliseconds earlier — passing
      // them here skips a duplicate runAsAdmin round-trip on the hottest
      // endpoint. Internal callers (Whish settlement) omit it and the service
      // resolves as before. Rows must match ctx.sourceId / input.companyId.
      preloaded?: {
        source: { id: string; code: string; status: string };
        company: { id: string; status: string; networkFeeEnabled: boolean };
      };
    },
    input: IngestTransactionInput,
    // `replayed` is attached to the returned transaction (rather than a wrapper)
    // so every existing caller that just wants the transaction is unaffected;
    // only the ingest controller reads the flag.
  ): Promise<TransactionResponse & { replayed: boolean }> {
    // Quantize ONCE, here, at the boundary of the money engine. The HTTP schema
    // already does this for the public ingest surface, but internal callers reach
    // this method directly — Whish settlement passes the amount stored on a
    // whish_payments row, and a row written before the money-scale change can
    // carry a longer tail. An over-scale amount would flow into the ledger legs
    // and be refused by writeEntries, failing a settlement for money the provider
    // has ALREADY collected. Rounding here (never rejecting) keeps that money
    // bookable, and every leg below derives from this single figure.
    const amount = Money.of(input.amount).round();
    // Reject not just non-positive but also sub-unit amounts that round to 0 at
    // the platform money scale (they would pass isPositive() yet violate the DB
    // amount>0 CHECK and surface as a 500).
    if (!amount.isPositive()) {
      throw new ValidationError(`amount must be positive at up to ${MONEY_SCALE_LABEL}`);
    }

    const [foundSource, company] =
      ctx.preloaded &&
      ctx.preloaded.source.id === ctx.sourceId &&
      ctx.preloaded.company.id === input.companyId
        ? [ctx.preloaded.source, ctx.preloaded.company]
        : await this.prisma.runAsAdmin((tx) =>
            Promise.all([
              tx.source.findUnique({ where: { id: ctx.sourceId } }),
              tx.company.findUnique({ where: { id: input.companyId } }),
            ]),
          );
    if (!foundSource || foundSource.status !== 'ACTIVE') {
      throw new ValidationError('source not found or inactive');
    }
    if (!company || company.status !== 'ACTIVE') {
      // No identifier in the message: this error can cross the source-facing
      // boundary (an admin deactivates the company mid-request), and internal
      // UUIDs must never reach a source. The id lives in the server log below.
      this.logger.warn(`ingest rejected: company ${input.companyId} not found or inactive`);
      throw new ValidationError('company not found or inactive');
    }
    // `company.visible` is intentionally NOT an ingest gate. It controls one thing
    // only: whether the company appears in the source-facing discovery list
    // (GET /v1/ingest/companies). Hiding a company from discovery must never strand
    // money already in flight — e.g. a Whish collect-link that was paid before the
    // company was hidden still settles here. The single hard "this company can do
    // nothing" switch is deactivation (status !== ACTIVE), enforced just above.
    const companyId = company.id;
    // The network-fee master switch, read from the same fresh (uncached) company
    // row as the status check — so a company with it OFF adds no query at all.
    const networkFeeEnabled = company.networkFeeEnabled;
    const source: { id: string; code: string; status: string } = foundSource;

    // Source fee = what this source charges THE PLATFORM on this deposit (cost of
    // funds), frozen here at settlement and persisted so net-revenue analytics can
    // SUM a column instead of recomputing per-deposit at query time. Computed
    // OUTSIDE the money transaction and best-effort: a reporting figure must never
    // block or roll back a real deposit, so any failure defaults to 0.
    const channel: SourceFeeChannel = ctx.channel ?? SourceFeeChannel.INGEST;
    let sourceFeeAmount = Money.zero();
    try {
      // Cache the (rarely-changing) rule set per (source, channel) so we don't open
      // a second RLS-bypass DB transaction per deposit. On a miss the fetch still
      // runs inside runAsAdmin; rows are mapped to plain string fields so the JSON
      // cache round-trip is lossless (computeSourceFee reads every value via
      // .toString()). Busted by SourcesService.setFeeRules on any schedule change.
      const feeRules = await this.cache.wrap(
        `sourcefee:rules:${source.id}:${channel}`,
        SOURCE_FEE_RULE_CACHE_TTL_SEC,
        () =>
          this.prisma.runAsAdmin((tx) =>
            tx.sourceFeeRule
              .findMany({ where: { sourceId: source.id, channel, active: true } })
              .then((rows) =>
                rows.map((r) => ({
                  channel: r.channel,
                  minAmount: r.minAmount.toString(),
                  maxAmount: r.maxAmount === null ? null : r.maxAmount.toString(),
                  feeType: r.feeType,
                  feeValue: r.feeValue.toString(),
                  active: r.active,
                })),
              ),
          ),
      );
      sourceFeeAmount = computeSourceFee(feeRules, channel, amount);
    } catch (err) {
      this.logger.warn(
        `source-fee compute failed (source=${source.id}, channel=${channel}); defaulting to 0: ${(err as Error).message}`,
      );
    }

    // Run the whole financial mutation scoped to the target company, so RLS
    // WITH CHECK validates that every row written (transaction, ledger, wallet)
    // belongs to `companyId` — a bug can't mis-book into another tenant.
    const { result, replayed, pricingIssue, networkCapped } =
      await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
        const cTx = tx as unknown as PrismaClient;

        // ---- idempotency: explicit key OR natural (source,external) pair ----
        if (input.idempotencyKey) {
          const existing = await cTx.transaction.findFirst({
            where: { companyId, idempotencyKey: input.idempotencyKey },
          });
          if (existing) {
            return {
              result: await this.mapTransaction(cTx, existing),
              replayed: true,
              pricingIssue: null,
              networkCapped: false,
            };
          }
        }
        // Natural idempotency: a repeat of the same (source, externalId) for this
        // company replays the existing row. The (source, externalId) unique index
        // is global, so a *different* company reusing the same pair is rejected by
        // that constraint on insert (surfaced as a 409) — it can't be observed
        // here under tenant scope, so there's nothing to second-guess.
        const dup = await cTx.transaction.findFirst({
          where: { sourceId: source.id, externalTransactionId: input.externalTransactionId },
        });
        if (dup) {
          return {
            result: await this.mapTransaction(cTx, dup),
            replayed: true,
            pricingIssue: null,
            networkCapped: false,
          };
        }

        // ---- commission ----
        // Channel-split pricing policy:
        //   - INGEST (external HTTP push): the deposit already happened at the
        //     source and CANNOT bounce. Pricing gaps book at net 0 — the full
        //     amount withheld as platform fee (recoverable by a later operator
        //     credit; the reverse, giving money away, would need a clawback):
        //       * capFeeAtAmount: DEDUCTED fee > amount → capped AT the amount;
        //       * no matching rule (resolveOptional → null) → fee = amount.
        //     Both marked on the row (`pricing_issue`) and alerted OUTSIDE the
        //     tx (see `pricingIssue` below).
        //   - WHISH_PAY (internal collect-link settlement): STRICT resolve.
        //     A pricing throw here parks the paid link as needsAttention, and
        //     an admin Refresh settles it AT THE CORRECT FEE once pricing is
        //     fixed — strictly better than an irreversible net-0 booking that
        //     would also push a completed CRM event while crediting nothing.
        const neverBounce = channel === SourceFeeChannel.INGEST;
        const rules = await this.commissionsRepo.loadCandidates(cTx, {
          companyId,
          sourceId: source.id,
          operationType: 'TRANSACTION',
        });
        const resolveArgs = {
          companyId,
          sourceId: source.id,
          operationType: 'TRANSACTION' as const,
          amount,
          rules,
        };
        const resolution = neverBounce
          ? this.resolver.resolveOptional({ ...resolveArgs, capFeeAtAmount: true })
          : this.resolver.resolve(resolveArgs);
        const pricingIssue: 'unpriced' | 'capped' | null =
          resolution === null ? 'unpriced' : resolution.capped ? 'capped' : null;

        // Honour the rule's fee application (mirrors loads.approve):
        //   DEDUCTED: external = amount,       company credited amount − fee
        //   ON_TOP:   external = amount + fee, company credited the full amount
        // `availableCredit` is the persisted netAmount (what the wallet receives).
        // Unpriced falls back to DEDUCTED with fee = amount (net 0).
        const feeApplication = resolution?.feeApplication ?? 'DEDUCTED';
        const fee = resolution?.commissionAmount ?? amount;

        // ---- network fee ----
        // The optional per-company second fee, computed BESIDE the commission
        // above (which is untouched) and on the same amount. Only a properly
        // priced deposit carries one: an unpriced or commission-capped booking
        // already withholds the whole amount. Under DEDUCTED it may take only
        // what the commission leaves, so it can never push net below zero —
        // switching it on never makes a deposit that books today fail or park.
        let network = Money.zero();
        let networkCapped = false;
        if (networkFeeEnabled && resolution && !resolution.capped) {
          const computed = computeNetworkFee(
            amount,
            await readNetworkFeeRate(cTx, companyId, 'TRANSACTION', { switchKnownOn: true }),
          );
          ({ network, capped: networkCapped } = boundDepositNetworkFee({
            amount,
            commission: fee,
            feeApplication,
            computed,
          }));
        }
        const fees: FeeParts = { commission: fee, network };
        const { externalDebit, availableCredit } = ingestSplit(amount, fees, feeApplication);

        // ---- insert transaction row ----
        // A different company reusing the same (source, externalTransactionId)
        // pair can't be seen by the tenant-scoped findFirst above, so it surfaces
        // here as the global unique-constraint violation (P2002). Translate it to
        // a clear DUPLICATE_TRANSACTION 409 instead of leaking a raw Prisma error.
        let txRow;
        try {
          txRow = await cTx.transaction.create({
            data: {
              companyId,
              sourceId: source.id,
              externalTransactionId: input.externalTransactionId,
              amount: amount.toString(),
              currency: input.currency,
              commissionAmount: fee.toString(),
              networkFeeAmount: network.toString(),
              netAmount: availableCredit.toString(),
              sourceFeeAmount: sourceFeeAmount.toString(),
              status: 'COMPLETED',
              // Durable, queryable marker of a net-0 pricing-gap booking — the
              // operator compensation query is `WHERE pricing_issue IS NOT NULL`.
              pricingIssue,
              payload: (input.payload ?? {}) as Prisma.InputJsonValue,
              idempotencyKey: input.idempotencyKey ?? null,
              processedAt: new Date(),
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new DuplicateTransactionError(input.externalTransactionId);
          }
          throw e;
        }

        // ---- ledger: balanced double-entry ----
        // DEBIT  EXTERNAL    externalDebit   (the outside world owes us this)
        // CREDIT AVAILABLE   availableCredit (company's spendable balance grows) [skip if 0]
        // CREDIT FEE         fee             (platform fee revenue)              [skip if 0]
        // CREDIT NETWORK_FEE network         (network-fee revenue)               [skip if 0]
        await this.ledger.writeEntries(
          cTx,
          moneyInEntries({ transactionId: txRow.id }, companyId, input.currency, {
            externalDebit,
            receivableSettle: Money.zero(),
            availableCredit,
            fees,
          }),
        );

        // ---- wallet delta (only if the company is credited something) ----
        if (availableCredit.isPositive()) {
          await this.wallets.applyDelta(cTx, {
            companyId,
            currency: input.currency,
            delta: { available: availableCredit },
          });
        }

        this.logger.log(
          `ingest tx=${txRow.id} co=${companyId} src=${source.code} ` +
            `amount=${amount.toString()} fee=${fee.toString()} ` +
            `${network.isPositive() ? `network=${network.toString()} ` : ''}` +
            `net=${availableCredit.toString()} app=${feeApplication}` +
            `${pricingIssue ? ` pricing=${pricingIssue}` : ''} ${input.currency}`,
        );

        return {
          result: await this.mapTransaction(cTx, txRow),
          replayed: false,
          pricingIssue,
          networkCapped,
        };
      });

    // A pricing gap no longer blocks the deposit (it books at net 0), but it is
    // still an operator problem: the company is credited nothing until the rule
    // is fixed and the flagged rows (pricing_issue IS NOT NULL) compensated.
    // Surface EVERY kind loudly — per-kind counter + deduped operator alert —
    // OUTSIDE the serializable tx so a retry can't double-fire, and only for a
    // genuinely new booking (replays carry none).
    if (pricingIssue) {
      this.logger.warn(
        `ingest booked at net 0 (${pricingIssue}): co=${companyId} src=${source.code} ` +
          `amount=${amount.toString()} — fix the commission rule`,
      );
      this.pricingIssueCounter.inc({
        source_code: source.code,
        currency: input.currency,
        issue: pricingIssue,
      });
      // Legacy metric kept incrementing for existing dashboards/alerts.
      if (pricingIssue === 'unpriced') {
        this.noRuleCounter.inc({ source_code: source.code, currency: input.currency });
      }
      void this.warnPricingIssue(pricingIssue, companyId, source.code, source.id, input);
    }

    // A network fee reduced to fit a small DEDUCTED deposit. Configured pricing
    // meeting a tiny amount, not a pricing gap, so it never sets pricing_issue or
    // the pricing alert metric — but the deposit nets 0, so it is logged (deduped).
    if (networkCapped) {
      void this.warnNetworkCapped(companyId, source.code, source.id, input);
    }

    // An idempotent replay (explicit key or natural (source,externalId) pair)
    // books NO new money — the ledger/wallet writes were skipped above — so it
    // must not bump the ingest counter, churn the analytics cache, or push a
    // realtime refresh. Only a genuinely new transaction triggers the side effects.
    if (!replayed) {
      this.ingestCounter.inc({ source_code: source.code, currency: input.currency });

      // Refresh ALL analytics (company + admin/platform) BEFORE announcing the
      // change, so every dashboard's realtime refetch reads fresh data, not a
      // warm cache. Awaited so the emit below can't race the invalidation.
      await this.analytics
        .invalidateAll()
        .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

      this.realtime.company(companyId, ['transactions', 'wallets', 'ledger', 'analytics']);

      // Push the completed transaction to the company's CRM (durable, retried,
      // fire-and-forget). For a Whish-originated tx this carries the same
      // `whish:<externalId>` reference as the earlier PENDING event, so the CRM
      // upserts the existing record from pending → completed.
      this.crm.emitFromTransaction(result, 'transaction.completed');
    }

    return { ...result, replayed };
  }

  /**
   * Best-effort operator alert when an ingest books at net 0 because of a
   * pricing gap ('unpriced': no commission rule matched; 'capped': a DEDUCTED
   * fee larger than the amount was capped at it). The deposit still BOOKS —
   * see the pricing block in ingest() — but the company is credited nothing
   * until an operator fixes pricing and compensates the rows flagged with
   * `pricing_issue`. Deduped per (kind, company, source) via a TTL'd cache
   * lock so a busy source can't flood the log. Never throws — alerting must
   * not affect the money path.
   */
  private async warnPricingIssue(
    kind: 'unpriced' | 'capped',
    companyId: string,
    sourceCode: string,
    sourceId: string,
    input: IngestTransactionInput,
  ): Promise<void> {
    try {
      const token = await this.cache.tryLock(
        `ingest-pricing:${kind}:${companyId}:${sourceId}`,
        NO_RULE_ALERT_TTL_MS,
      );
      if (!token) return; // already alerted within the window
      const cause =
        kind === 'unpriced'
          ? `has no commission rule for source ${sourceCode}`
          : `has a DEDUCTED commission rule whose fee exceeds small deposits from source ${sourceCode}`;
      this.logger.error(
        `Ingest ${kind.toUpperCase()} — company ${companyId} ${cause}; ` +
          `${input.currency} ${input.amount} was booked at net 0 (full amount withheld as fee). ` +
          `The company is credited NOTHING until pricing is fixed (admin → Commissions) and the ` +
          `flagged transactions (pricing_issue IS NOT NULL) are compensated.`,
      );
    } catch {
      // Best-effort: alerting must never affect the money path.
    }
  }

  /**
   * Best-effort, deduped log when a deposit's network fee was reduced so the
   * deposit could book (net 0). Unlike warnPricingIssue this is NOT an operator
   * alert: the price is configured, the deposit was simply smaller than the fees.
   * Never throws — logging must not affect the money path.
   */
  private async warnNetworkCapped(
    companyId: string,
    sourceCode: string,
    sourceId: string,
    input: IngestTransactionInput,
  ): Promise<void> {
    try {
      const token = await this.cache.tryLock(
        `ingest-network-capped:${companyId}:${sourceId}`,
        NO_RULE_ALERT_TTL_MS,
      );
      if (!token) return; // already logged within the window
      this.logger.warn(
        `Network fee capped — company ${companyId}, source ${sourceCode}: a ` +
          `${input.currency} ${input.amount} deposit was smaller than its commission plus ` +
          `network fee, so the network fee was reduced to what the commission left and ` +
          `the deposit booked at net 0.`,
      );
    } catch {
      // Best-effort: logging must never affect the money path.
    }
  }

  /**
   * Reverse a COMPLETED transaction. Writes compensating ledger entries
   * (mirror of the original) and claws the credited funds back from available.
   * If the company has already spent/withdrawn some of the credit, the part
   * that available can't cover is booked to the RECEIVABLE account as a debt
   * the company owes the platform — so a reversal is ALWAYS recordable and the
   * loss can never silently sit on the books as a stuck COMPLETED row.
   *
   * Idempotent: a tx already in REVERSED state returns its current row.
   */
  async reverse(
    txId: string,
    args: { actorId: string; reason: string },
  ): Promise<TransactionResponse> {
    // Admin action: look up the owning company first, then run the mutation
    // scoped to it so RLS WITH CHECK validates every compensating write.
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: txId }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Transaction', txId);
    const reversed = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const orig = await cTx.transaction.findUnique({
        where: { id: txId },
        include: { source: { select: { code: true } } },
      });
      if (!orig) throw new NotFoundError('Transaction', txId);
      if (orig.status === 'REVERSED') {
        return orig;
      }
      if (orig.status !== 'COMPLETED') {
        throw new ConflictError(`Transaction is in status ${orig.status} and cannot be reversed`);
      }

      // fromDb: quantize the stored amounts ONCE here, so every leg derived below
      // is at scale and the reversal set balances by construction.
      const fees: FeeParts = {
        commission: Money.fromDb(orig.commissionAmount),
        network: Money.fromDb(orig.networkFeeAmount),
      };
      const net = Money.fromDb(orig.netAmount);
      // The original EXTERNAL debit was net + commission + network for BOTH fee
      // applications (DEDUCTED: amount = net + fees; ON_TOP: amount + fees =
      // net + fees), so reversalEntries reconstructs it from the stored net/fees
      // without a feeApplication column and the reversal balances either way.

      // Claw `net` back from available; whatever available can't cover becomes a
      // RECEIVABLE (a debt the company owes). This keeps available >= 0 and the
      // ledger balanced whether or not the funds were already withdrawn.
      const walletRow = await cTx.wallet.findUnique({
        where: { companyId_currency: { companyId: orig.companyId, currency: orig.currency } },
      });
      const available = Money.of(walletRow?.availableBalance.toString() ?? '0');
      const { fromAvailable, receivable } = splitClawback(net, available);

      // Compensating ledger entries: mirror the original signs.
      // original was: DEBIT EXTERNAL, CREDIT AVAILABLE, CREDIT FEE, CREDIT NETWORK_FEE
      // reversal is:  CREDIT EXTERNAL, DEBIT AVAILABLE (+ DEBIT RECEIVABLE for the
      // uncovered remainder), DEBIT FEE, DEBIT NETWORK_FEE. debits (fromAvailable +
      // receivable + fees) == credit (net + fees), so the set stays balanced.
      await this.ledger.writeEntries(
        cTx,
        reversalEntries({ transactionId: orig.id }, orig.companyId, orig.currency, {
          net,
          fees,
          fromAvailable,
          receivable,
          reason: args.reason,
        }),
      );

      // Wallet: subtract only what available could cover (stays >= 0).
      if (fromAvailable.isPositive()) {
        await this.wallets.applyDelta(cTx, {
          companyId: orig.companyId,
          currency: orig.currency,
          delta: { available: fromAvailable.mul(-1) },
        });
      }
      if (receivable.isPositive()) {
        this.logger.warn(
          `reversal of tx=${orig.id} co=${orig.companyId} created RECEIVABLE=${receivable.toString()} ${orig.currency.trim()} (available could not cover full clawback of ${net.toString()})`,
        );
      }

      const updated = await cTx.transaction.update({
        where: { id: orig.id },
        data: { status: 'REVERSED' },
        include: { source: { select: { code: true } } },
      });
      return updated;
    });

    this.logger.log(
      `reversed tx=${reversed.id} co=${reversed.companyId} amount=${reversed.amount.toString()} reason=${args.reason}`,
    );

    // Reversal flips the wallet + ledger — refresh all analytics before emit.
    await this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

    this.realtime.company(reversed.companyId, ['transactions', 'wallets', 'ledger', 'analytics']);

    const response = mapTxRow(
      reversed,
      (reversed as { source?: { code: string } }).source?.code ?? '',
    );
    // Tell the company's CRM the record was reversed (same reference as the
    // original completed event, so the CRM flips that record to REVERSED).
    this.crm.emitFromTransaction(response, 'transaction.reversed');
    return response;
  }

  /**
   * Stream ALL transactions matching the filters as CSV (no row cap), walked in
   * keyset chunks over (createdAt desc, id desc). Each chunk is fetched in its
   * own short RLS-scoped query and emitted as it's produced, so memory stays
   * bounded to one chunk and no transaction is held open across the download.
   */
  streamCsv(args: {
    companyId?: string;
    query: ListTransactionsQuery;
    /** Back office gets only what the customer paid — see common/backoffice-view.ts. */
    backoffice?: boolean;
  }): StreamableFile {
    const header = [
      'id',
      'created_at',
      'company_id',
      'source_code',
      'external_transaction_id',
      'amount',
      'currency',
      'commission_amount',
      'net_amount',
      'status',
      'customer',
      'target',
      'phone',
      'note',
      // Appended last (positions above stay stable for existing parsers):
      // when the transaction settled — mirrors the flow exports' processed_at.
      'processed_at',
      // The optional per-company network fee (0.00 when not charged). Appended
      // after processed_at for the same reason.
      'network_fee_amount',
    ];

    const where: Prisma.TransactionWhereInput = {};
    if (args.companyId) where.companyId = args.companyId;
    else if (args.query.companyId) where.companyId = args.query.companyId;
    if (args.query.status) where.status = args.query.status;
    if (args.query.sourceId) where.sourceId = args.query.sourceId;
    if (args.query.currency) where.currency = args.query.currency;
    // Mirror the list view's search so an exported CSV contains exactly the
    // filtered rows the user is looking at.
    if (args.query.search) {
      where.externalTransactionId = { contains: args.query.search };
    }
    if (args.query.from || args.query.to) {
      where.createdAt = {};
      if (args.query.from) where.createdAt.gte = new Date(args.query.from);
      if (args.query.to) where.createdAt.lte = new Date(args.query.to);
    }

    const prisma = this.prisma;
    const scope = args.companyId ?? null;
    const backoffice = args.backoffice === true;

    async function* generate(): AsyncGenerator<string> {
      // Lead with a UTF-8 BOM so Excel reads the file as UTF-8 (else “•” etc. shows as mojibake). Matches the shared CSV exporter.
      yield '\uFEFF' + header.join(',') + '\n';
      let cursor: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const pageWhere: Prisma.TransactionWhereInput = cursor
          ? {
              ...where,
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : where;
        // Each chunk is its own short, RLS-scoped query (admin → bypass when
        // scope is null). New rows inserted mid-export land at the top of the
        // (createdAt desc) order we've already passed, so the keyset walk never
        // double-reads or skips.
        const page = await prisma.runAsScoped(scope, (tx) =>
          tx.transaction.findMany({
            where: pageWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: CSV_EXPORT_CHUNK,
            include: { source: { select: { code: true } } },
          }),
        );
        if (page.length === 0) break;
        let buf = '';
        for (const r of page) {
          const commission = Money.fromDb(r.commissionAmount);
          const networkFee = Money.fromDb(r.networkFeeAmount);
          const net = Money.fromDb(r.netAmount);
          const cells = [
            r.id,
            r.createdAt.toISOString(),
            r.companyId,
            r.source.code,
            csvCell(r.externalTransactionId),
            Money.fromDb(r.amount).toFixed(2),
            r.currency.trim(),
            commission.toFixed(2),
            net.toFixed(2),
            r.status,
            csvCell(payloadString(r.payload, 'customer') ?? ''),
            csvCell(payloadString(r.payload, 'target') ?? ''),
            csvCell(payloadString(r.payload, 'phone') ?? ''),
            csvCell(payloadString(r.payload, 'note') ?? ''),
            r.processedAt?.toISOString() ?? '',
            networkFee.toFixed(2),
          ];
          buf +=
            (backoffice
              ? // Only what the customer paid; the split columns stay, blank.
                backofficeCsvCells(header, cells, {
                  hide: ['commission_amount', 'net_amount', 'network_fee_amount'],
                  overrides: { amount: net.add(commission).add(networkFee).toFixed(2) },
                })
              : cells
            ).join(',') + '\n';
        }
        yield buf;
        if (page.length < CSV_EXPORT_CHUNK) break;
        const last = page[page.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
    }

    return new StreamableFile(Readable.from(generate()), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="transactions-${Date.now()}.csv"`,
    });
  }

  async list(args: {
    companyId?: string;
    query: ListTransactionsQuery;
  }): Promise<PaginatedResponse<TransactionResponse>> {
    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      const where: Prisma.TransactionWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.sourceId) where.sourceId = args.query.sourceId;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.from || args.query.to) {
        where.createdAt = {};
        if (args.query.from) where.createdAt.gte = new Date(args.query.from);
        if (args.query.to) where.createdAt.lte = new Date(args.query.to);
      }
      if (args.query.search) {
        where.externalTransactionId = { contains: args.query.search };
      }

      const skip = (args.query.page - 1) * args.query.pageSize;
      if (skip > MAX_LIST_OFFSET) {
        throw new ValidationError(
          `Page too deep to scan efficiently. Narrow the results with filters (date range, status, source) or use Export CSV.`,
        );
      }
      const countKey =
        `list-count:txn:${args.companyId ?? args.query.companyId ?? 'all'}` +
        `:${args.query.status ?? ''}:${args.query.sourceId ?? ''}:${args.query.currency ?? ''}` +
        `:${args.query.from ?? ''}:${args.query.to ?? ''}:${args.query.search ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.transaction.findMany({
          where,
          // createdAt alone isn't a total order; add id so rows with the same
          // timestamp can't shuffle across page boundaries under high ingest.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: args.query.pageSize,
          // Join the source code for just this page's rows (indexed FK). Cheaper
          // and more scalable than loading the whole sources table per request.
          include: { source: { select: { code: true } } },
        }),
        // singleFlight:false — runs inside the caller's tx; compute-on-miss, never
        // block on the cross-request poll (which would pin this pooled connection).
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.transaction.count({ where }), {
          singleFlight: false,
        }),
      ]);

      return {
        data: rows.map((r) => mapTxRow(r, r.source.code)),
        meta: {
          page: args.query.page,
          pageSize: args.query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / args.query.pageSize)),
        },
      };
    });
  }

  async getById(id: string, companyId?: string): Promise<TransactionResponse> {
    const row = await this.prisma.runAsScoped(companyId ?? null, (tx) =>
      tx.transaction.findUnique({
        where: { id },
        include: { source: { select: { code: true } } },
      }),
    );
    if (!row) throw new NotFoundError('Transaction', id);
    if (companyId && row.companyId !== companyId) throw new NotFoundError('Transaction', id);
    return mapTxRow(row, row.source.code);
  }

  /**
   * Fetch a transaction plus all its ledger entries. Used by the
   * transaction-detail drawer in the dashboard so users can audit the
   * full double-entry trail without leaving the row.
   */
  async getDetail(id: string, companyId?: string) {
    return this.prisma.runAsScoped(companyId ?? null, async (tx) => {
      const row = await tx.transaction.findUnique({
        where: { id },
        include: { source: { select: { code: true } } },
      });
      if (!row) throw new NotFoundError('Transaction', id);
      if (companyId && row.companyId !== companyId) throw new NotFoundError('Transaction', id);
      const entries = await tx.ledgerEntry.findMany({
        where: { transactionId: id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        transaction: {
          ...mapTxRow(row, row.source.code),
          payload: (row.payload as Record<string, unknown> | null) ?? null,
          idempotencyKey: row.idempotencyKey,
        },
        ledgerEntries: entries.map((e) => ({
          id: e.id,
          accountType: e.accountType,
          direction: e.direction,
          amount: e.amount.toString(),
          currency: e.currency.trim(),
          metadata: (e.metadata as Record<string, unknown> | null) ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    });
  }

  private async mapTransaction(
    tx: PrismaClient,
    row: {
      id: string;
      companyId: string;
      sourceId: string;
      externalTransactionId: string;
      amount: { toString(): string };
      currency: string;
      commissionAmount: { toString(): string };
      networkFeeAmount: { toString(): string };
      netAmount: { toString(): string };
      status: TransactionResponse['status'];
      payload?: unknown;
      processedAt: Date | null;
      createdAt: Date;
    },
  ): Promise<TransactionResponse> {
    const source = await tx.source.findUnique({
      where: { id: row.sourceId },
      select: { code: true },
    });
    return mapTxRow(row, source?.code ?? '');
  }
}

/**
 * Split an ingest amount into the EXTERNAL debit and the AVAILABLE credit
 * according to how the fees are applied:
 *   - DEDUCTED: the fees come out of the amount → external = amount, the
 *     company is credited amount − commission − network.
 *   - ON_TOP:   the fees are charged on top → external = amount + both fees,
 *     the company is credited the full amount.
 * In both cases external = credit + both fees, so the ledger set stays balanced.
 */
export function ingestSplit(
  amount: Money,
  fees: FeeParts,
  feeApplication: FeeApplication,
): { externalDebit: Money; availableCredit: Money } {
  // Delegate to the canonical split so the ON_TOP/DEDUCTED arithmetic can't drift
  // between ingest, loads, and the money-out flows.
  return {
    externalDebit: reservedTotal(amount, fees, feeApplication),
    availableCredit: netOfFee(amount, fees, feeApplication),
  };
}

/**
 * Split a clawback of `net` against the current available balance: take what
 * the wallet can cover (capped, so available never goes below zero) and record
 * the rest as a receivable (a debt the company owes). `fromAvailable + receivable`
 * always equals `net`, so the reversal ledger set stays balanced.
 */
export function splitClawback(
  net: Money,
  available: Money,
): { fromAvailable: Money; receivable: Money } {
  // The cap comes from a wallet balance, which may carry a wider tail than the
  // money scale. floorToScale, never round: rounding half-even could round UP
  // past the real balance and drive the wallet negative. The receivable is then
  // derived by exact subtraction, so the two legs still sum to `net`.
  const cap = available.floorToScale();
  const fromAvailable = cap.gte(net) ? net : cap;
  return { fromAvailable, receivable: net.sub(fromAvailable) };
}

function mapTxRow(
  row: {
    id: string;
    companyId: string;
    sourceId: string;
    externalTransactionId: string;
    amount: { toString(): string };
    currency: string;
    commissionAmount: { toString(): string };
    networkFeeAmount: { toString(): string };
    netAmount: { toString(): string };
    status: TransactionResponse['status'];
    payload?: unknown;
    processedAt: Date | null;
    createdAt: Date;
  },
  sourceCode: string,
): TransactionResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceId: row.sourceId,
    sourceCode,
    externalTransactionId: row.externalTransactionId,
    // Quantized on the way out — see the flow mappers: one figure across the API,
    // the CSV export and the CRM event.
    amount: Money.fromDb(row.amount).toString(),
    currency: row.currency.trim(),
    commissionAmount: Money.fromDb(row.commissionAmount).toString(),
    networkFeeAmount: Money.fromDb(row.networkFeeAmount).toString(),
    netAmount: Money.fromDb(row.netAmount).toString(),
    status: row.status,
    customer: payloadString(row.payload, 'customer'),
    target: payloadString(row.payload, 'target'),
    phone: payloadString(row.payload, 'phone'),
    note: payloadString(row.payload, 'note'),
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Lift a known descriptive field out of the JSONB payload. Returns the string
 * value, or null when absent — or when a legacy row still has it as an object
 * (pre-flattening), so old data degrades gracefully instead of leaking `[object
 * Object]` into the response.
 */
function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
