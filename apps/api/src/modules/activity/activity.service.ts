import { Injectable, StreamableFile } from '@nestjs/common';
import {
  ACTIVITY_DIRECTION,
  SUPPORTED_CURRENCIES,
  type ActivityItem,
  type ActivityKind,
  type ActivityListResponse,
  type ListActivityQuery,
  type AdminAttention,
  type PendingCounts,
} from '@app/shared';
import type { PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { ValidationError } from '../../common/errors/domain.error';
import { BACKOFFICE_CSV_COLUMNS, backofficeCsvCells } from '../../common/backoffice-view';
import { streamCsvKeyset } from '../../common/csv';
import { isStuckProcessing, processingSince } from '../withdrawals/stuck-processing';
import { depositSearchSql, flowSearchSql, searchTerm } from '../../common/search';

// Cache the list COUNT briefly so paging reuses it (same tradeoff as the
// per-type lists). Rows are always live; only the total can lag by this window.
const LIST_COUNT_CACHE_TTL_SEC = 30;
// Same deep-paging guard the per-type lists use: an OFFSET beyond this is
// rejected with a "narrow your filters" message rather than scanning forever.
const MAX_LIST_OFFSET = 50_000;
// Above this many completed ops for a (company, currency), the running-balance
// window would materialize too much, so balance mode gracefully degrades to the
// plain (bounded) feed and the balance column simply hides. Keeps the worst case
// bounded without changing the (verified-correct) balance math for normal tenants.
const BALANCE_MODE_MAX_ROWS = 25_000;

// One DB row of the unified feed (snake_case straight from the raw query).
// `amount` is the GROSS money that actually moved (net + fee + network fee) —
// never the bare requested figure, whose meaning flips with fee_application.
// The one exception is a deposit built for back office (see FeedAudience).
interface ActivityRow {
  id: string;
  kind: ActivityKind;
  amount: string;
  currency: string;
  fee: string;
  // The optional per-company network fee ('0.00' when not charged).
  network_fee: string;
  net: string;
  fee_application?: string | null;
  description: string | null;
  details: string | null;
  reference: string | null;
  created_at: Date;
  processed_at: Date | null;
  company_id: string;
  company_name: string | null;
  // Free-text notes, unified across the four kinds: a deposit's note lives in its
  // JSON payload, the three flows have real columns. admin_notes is flow-only.
  notes?: string | null;
  admin_notes?: string | null;
  // Counterparty, mirrored from the per-flow exports (flow-csv.ts): recipient
  // name + contact for the three flows; the paying customer + phone for a deposit.
  recipient_name?: string | null;
  recipient_contact?: string | null;
  // Deposit-only: the trading account the customer paid (payload `target`).
  target?: string | null;
  balance_after?: string | null;
}

// The activity CSV header. Exported-position contract: columns are only ever
// appended (see the comments inline).
export const ACTIVITY_CSV_HEADER = [
  'id',
  'kind',
  'direction',
  'created_at',
  'completed_at',
  'company_id',
  'company_name',
  'description',
  'details',
  'reference',
  'currency',
  // Same money-column contract as the per-flow exports (flow-csv.ts): the
  // gross that actually moved, its split, and the fee mode — never a bare
  // `amount`, whose meaning flips between gross (DEDUCTED) and net (ON_TOP).
  'gross_amount',
  'fee_amount',
  'net_amount',
  'fee_application',
  // Appended after the original columns so existing positions stay stable
  // for anyone already parsing this export. Mirrors the per-flow exports
  // (flow-csv.ts), which have carried all four columns all along — for a
  // deposit the "recipient" pair is the paying customer + phone, and
  // admin_notes is always empty.
  'recipient_name',
  'recipient_contact',
  'target',
  'notes',
  'admin_notes',
  // The optional per-company network fee — appended last for the same
  // reason (gross_amount = fee_amount + network_fee_amount + net_amount).
  'network_fee_amount',
] as const;

/**
 * Read-only unified activity feed across the four money operations
 * (deposit/load/withdrawal/payout), COMPLETED only. A raw UNION ALL keeps it a
 * single paginated, chronologically-merged list; RLS (via runAsScoped) isolates
 * company callers while admins see everything. Nothing here mutates money.
 */

// Counterparty projection for the three payout-carrying flows, ONE fragment so
// the export's four union branches can never drift apart. The fallback order
// MUST stay in lockstep with `recipient()` in ../../common/flow-csv.ts — the
// per-flow CSVs derive the same two columns from that TS twin, and an
// integrating client already caught the two exports disagreeing once.
const FLOW_RECIPIENT_SQL = `
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'network', o.payout_details->>'description') AS recipient_name,
             COALESCE(o.payout_details->>'recipientPhone', o.payout_details->>'walletAddress',
                      o.payout_details->>'accountNumber', o.payout_details->>'bankName') AS recipient_contact,
             NULL::text AS target`.trim();

// Deposit twin: the paying customer + phone, plus the trading account (target).
const DEPOSIT_RECIPIENT_SQL = `
             o.payload->>'note' AS notes, NULL::text AS admin_notes,
             o.payload->>'customer' AS recipient_name, o.payload->>'phone' AS recipient_contact,
             o.payload->>'target' AS target`.trim();

// The fee column of each feed table: a deposit's commission lives in
// commission_amount, the three flows keep theirs in fee_amount.
type FeeColumn = 'commission_amount' | 'fee_amount';

// The GROSS that actually moved. Every table's bare `amount` is the requested
// figure (gross for DEDUCTED fees but net for ON_TOP), so the gross is always
// recomputed as net + fee + network fee — an identity that holds under both fee
// applications and needs no fee_application column (deposits don't have one).
// network_fee_amount is DECIMAL(20,2), so adding it never widens the sum's
// scale: the amount text is byte-identical to before for an unchanged row.
const grossSql = (fee: FeeColumn): string => `(o.net_amount + o.${fee} + o.network_fee_amount)`;

// The money columns of one feed row — ONE fragment for every branch of every
// union builder (list, balance mode, export), so the three can never drift
// apart on what `amount` means. Always aliased, so any branch can lead a UNION.
const moneyColsSql = (fee: FeeColumn, amountSql: string = grossSql(fee)): string =>
  `${amountSql}::text AS amount, o.currency,
             o.${fee}::text AS fee, o.network_fee_amount::text AS network_fee,
             o.net_amount::text AS net`;

// What a row shows for a flow's "details" (who it went to / came from).
const PAYOUT_DETAILS_SQL = `COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder', o.payout_details->>'walletAddress', o.payout_details->>'description', o.external_reference)`;
const DEPOSIT_DETAILS_SQL = `COALESCE(o.payload->>'customer', o.payload->>'target', o.payload->>'phone')`;

// The bound search values (see common/search.ts), placed by the query's own
// placeholder function. Every union builder takes them, so the rows, the count
// and the export always apply the same search to the same fields — the WHOLE
// row (every recipient detail, the phone typed any way), not the one field the
// row shows as its title.
interface SearchPh {
  like: string;
  digits: string | null;
}
function searchPh(search: string | undefined, p: (v: unknown) => string): SearchPh | null {
  if (!search) return null;
  const t = searchTerm(search);
  return { like: p(t.like), digits: t.digits ? p(t.digits) : null };
}
const flowSearchClause = (sp: SearchPh | null): string =>
  sp ? ` AND ${flowSearchSql(sp.like, sp.digits)}` : '';
const depositSearchClause = (sp: SearchPh | null): string =>
  sp ? ` AND ${depositSearchSql(sp.like, sp.digits, 's.code')}` : '';

/**
 * Who the feed is being built for. Back office gets ONE figure per operation
 * and nothing a fee could be derived from (common/backoffice-view.ts):
 *   - a deposit's `amount` is what the customer PAID — the stored amount, the
 *     same figure the source reported and the Whish pages show — instead of
 *     the gross (which for an ON_TOP deposit is the paid amount PLUS the fees);
 *   - no running wallet balance (consecutive balances reveal each row's net).
 */
interface FeedAudience {
  backoffice: boolean;
}

// A deposit's `amount`: the gross for everyone, the paid amount for back office.
const depositAmountSql = (audience: FeedAudience): string =>
  audience.backoffice ? 'o.amount' : grossSql('commission_amount');

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async list(args: {
    companyId?: string;
    query: ListActivityQuery;
    /** Back office gets one money figure per row — see FeedAudience. */
    backoffice?: boolean;
  }): Promise<ActivityListResponse> {
    const { query } = args;
    const audience: FeedAudience = { backoffice: args.backoffice === true };
    const skip = (query.page - 1) * query.pageSize;
    if (skip > MAX_LIST_OFFSET) {
      throw new ValidationError(
        'Page too deep to scan efficiently. Narrow the results with filters (date range, type, direction).',
      );
    }

    // Resolve the company the feed is scoped to: the caller's own (company
    // scope) or the admin's optional companyId filter. A company caller's
    // `companyId` query parameter is ignored — it is an admin-only filter.
    const isCompanyScope = Boolean(args.companyId);
    const adminCompanyId = isCompanyScope ? null : (query.companyId ?? null);
    const scopedCompanyId = args.companyId ?? adminCompanyId;
    // Whose rows the queries can see (RLS). Part of every cached count's key:
    // a count computed for one tenant must never be served to another, or to
    // the platform-wide admin view.
    const countScope = args.companyId ? `co:${args.companyId}` : 'admin';

    // Running balance ("balance mode") is only well-defined for a single
    // company + single currency, with no kind/direction/search filter that
    // would punch holes in the chronological sum. A date filter is still fine —
    // it's applied AFTER the cumulative window so balances stay absolute.
    // Back office never gets it, so its (heavier) queries are skipped too.
    const onlyCurrency = SUPPORTED_CURRENCIES.length === 1 ? SUPPORTED_CURRENCIES[0] : null;
    const effectiveCurrency = query.currency ?? onlyCurrency ?? null;
    const balanceMode =
      !audience.backoffice &&
      Boolean(scopedCompanyId) &&
      Boolean(effectiveCurrency) &&
      !query.kind &&
      !query.direction &&
      !query.search;

    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      // Degrade balance mode for very large histories so the window query can't
      // materialize an unbounded set — the feed still works, just without the
      // per-row running balance.
      let useBalance = balanceMode;
      if (useBalance) {
        const history = await this.completedCount(tx, scopedCompanyId!, effectiveCurrency!);
        if (history > BALANCE_MODE_MAX_ROWS) useBalance = false;
      }

      const { rows, total } = useBalance
        ? await this.queryBalanceMode(tx, {
            query,
            companyId: scopedCompanyId!,
            currency: effectiveCurrency!,
            skip,
            countScope,
          })
        : await this.queryNormal(tx, { query, adminCompanyId, skip, countScope, audience });

      return {
        data: rows.map((r) => this.mapRow(r, isCompanyScope, useBalance)),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
          balanceMode: useBalance,
        },
      };
    });
  }

  /**
   * Stream the unified activity feed (all four COMPLETED operations) matching
   * the filters as CSV, walked in keyset chunks over (created_at desc, id desc).
   * Mirrors the list filters (incl. the id/reference search) so the export
   * matches what the user sees. Each chunk is its own short RLS-scoped query.
   */
  streamCsv(args: {
    companyId?: string;
    query: ListActivityQuery;
    /** Back office gets one money figure per row — see common/backoffice-view.ts. */
    backoffice?: boolean;
  }): StreamableFile {
    const scope = args.companyId ?? null;
    // Admins may narrow to one company; company callers are already RLS-scoped.
    const adminCompanyId = args.companyId ? null : (args.query.companyId ?? null);
    const q = args.query;
    const prisma = this.prisma;
    const backoffice = args.backoffice === true;
    const unionSqlFor = this.unionSql.bind(this);
    const kindsFor = this.kindsFor.bind(this);

    return streamCsvKeyset<ActivityRow>({
      filename: `transactions-${Date.now()}.csv`,
      header: ACTIVITY_CSV_HEADER,
      fetchPage: (cursor, take) =>
        prisma.runAsScoped(scope, (tx) => {
          const params: unknown[] = [];
          const p = (v: unknown) => (params.push(v), `$${params.length}`);
          const cl: string[] = [];
          if (adminCompanyId) cl.push(`u.company_id = ${p(adminCompanyId)}::uuid`);
          if (q.direction) cl.push(`u.kind IN (${kindsFor(q.direction, p)})`);
          if (q.kind) cl.push(`u.kind = ${p(q.kind)}`);
          if (q.currency) cl.push(`u.currency = ${p(q.currency)}`);
          if (q.from) cl.push(`u.created_at >= ${p(new Date(q.from))}`);
          if (q.to) cl.push(`u.created_at <= ${p(new Date(q.to))}`);
          // The search runs inside each branch (every field of the row, not
          // just the projected ones) — the same rule as the list's rows + count.
          const unionSql = unionSqlFor({ backoffice }, searchPh(q.search, p));
          if (cursor) {
            const c = p(cursor.createdAt);
            const cid = p(cursor.id);
            cl.push(`(u.created_at < ${c} OR (u.created_at = ${c} AND u.id < ${cid}))`);
          }
          const where = cl.length ? `WHERE ${cl.join(' AND ')}` : '';
          const lim = p(take);
          return tx.$queryRawUnsafe<ActivityRow[]>(
            `SELECT * FROM (${unionSql}) u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${lim}`,
            ...params,
          );
        }),
      cursorOf: (r) => ({ createdAt: r.created_at, id: r.id }),
      toCells: (r) => {
        const cells = [
          r.id,
          r.kind,
          ACTIVITY_DIRECTION[r.kind],
          r.created_at.toISOString(),
          r.processed_at ? r.processed_at.toISOString() : '',
          r.company_id,
          r.company_name ?? '',
          r.description ?? '',
          r.details ?? '',
          r.reference ?? '',
          r.currency.trim(),
          r.amount,
          r.fee,
          r.net,
          r.fee_application ?? '',
          r.recipient_name ?? '',
          r.recipient_contact ?? '',
          r.target ?? '',
          r.notes ?? '',
          r.admin_notes ?? '',
          r.network_fee,
        ];
        if (!backoffice) return cells;
        // Back office: one figure per row, never a fee. Money in → gross_amount
        // (what the customer paid for a deposit, what is collected for a load);
        // money paid out (withdrawals, payouts) → net_amount.
        return backofficeCsvCells(
          ACTIVITY_CSV_HEADER,
          cells,
          BACKOFFICE_CSV_COLUMNS.activity[ACTIVITY_DIRECTION[r.kind] === 'OUT' ? 'out' : 'in'],
        );
      },
    });
  }

  /** Live count of a company's own PENDING requests (sidebar badges). */
  async companyPendingCounts(companyId: string): Promise<PendingCounts> {
    return this.prisma.runAsTenant(companyId, (tx) => this.countPending(tx));
  }

  /** Platform-wide PENDING request counts across all companies (admin badges). */
  async adminPendingCounts(): Promise<PendingCounts> {
    return this.prisma.runAsAdmin((tx) => this.countPending(tx));
  }

  /**
   * Money a person must look at now, platform-wide (admin sidebar alert, the
   * Withdrawals / Whish Pay banners and the Overview). PROCESSING is normally
   * seconds long, so that set is tiny; the stuck rule lives in
   * withdrawals/stuck-processing.ts. The Whish predicate is the one the admin
   * Whish list's "needs attention" filter uses, so the count matches the list.
   */
  async adminAttention(now: Date = new Date()): Promise<AdminAttention> {
    return this.prisma.runAsAdmin(async (tx) => {
      const [processing, whish] = await Promise.all([
        tx.withdrawal.findMany({
          where: { status: 'PROCESSING' },
          select: { status: true, metadata: true, updatedAt: true },
        }),
        tx.whishPayment.aggregate({
          where: { metadata: { path: ['needsAttention'], equals: true } },
          _count: { _all: true },
          _min: { createdAt: true },
        }),
      ]);
      const stuck = processing.filter((w) => isStuckProcessing(w, now));
      const oldestStuck = stuck.reduce<Date | null>((oldest, w) => {
        const since = processingSince(w);
        return !oldest || since < oldest ? since : oldest;
      }, null);
      return {
        stuckWithdrawals: { count: stuck.length, oldestAt: oldestStuck?.toISOString() ?? null },
        whishNeedsAttention: {
          count: whish._count._all,
          oldestAt: whish._min.createdAt?.toISOString() ?? null,
        },
      };
    });
  }

  private async countPending(tx: PrismaClient): Promise<PendingCounts> {
    const [withdrawals, payouts, loads] = await Promise.all([
      tx.withdrawal.count({ where: { status: 'PENDING' } }),
      tx.payout.count({ where: { status: 'PENDING' } }),
      tx.load.count({ where: { status: 'PENDING' } }),
    ]);
    return { withdrawals, payouts, loads };
  }

  // ---------- query builders ----------

  // The four COMPLETED operations projected to one shape (no running balance).
  // Used by the COUNT queries and the CSV export — the list row queries use the
  // bounded (normalRowsSql) or balance (balanceUnionSql) variants.
  // `amount` is the GROSS that actually moved (see grossSql) — except a deposit
  // shown to back office, which is the amount the customer paid (FeedAudience).
  private unionSql(
    audience: FeedAudience = { backoffice: false },
    search: SearchPh | null = null,
  ): string {
    const flowBranch = (kind: ActivityKind, table: string): string => `
      SELECT o.id, '${kind}'::text AS kind, ${moneyColsSql('fee_amount')},
             o.fee_application::text AS fee_application,
             o.payout_method::text AS description,
             ${PAYOUT_DETAILS_SQL} AS details,
             o.external_reference AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             o.notes, o.admin_notes,
             ${FLOW_RECIPIENT_SQL}
      FROM ${table} o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'${flowSearchClause(search)}`;
    return `
      SELECT o.id, 'DEPOSIT'::text AS kind, ${moneyColsSql('commission_amount', depositAmountSql(audience))},
             NULL::text AS fee_application,
             s.code AS description,
             ${DEPOSIT_DETAILS_SQL} AS details,
             o.external_transaction_id AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             ${DEPOSIT_RECIPIENT_SQL}
      FROM transactions o
      LEFT JOIN sources s ON s.id = o.source_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'${depositSearchClause(search)}
      UNION ALL${flowBranch('LOAD', 'loads')}
      UNION ALL${flowBranch('WITHDRAWAL', 'withdrawals')}
      UNION ALL${flowBranch('PAYOUT', 'payouts')}
    `;
  }

  // Balance-mode union: same projection PLUS the per-operation net effect on the
  // company's AVAILABLE wallet account. Instead of a correlated per-row subquery
  // (one ledger scan per row), each branch LEFT JOINs a single company-scoped,
  // grouped pre-aggregation of the AVAILABLE ledger — one hash-aggregate + hash
  // join, not N lookups. The `company_id = $company` filter is REQUIRED: in the
  // admin (RLS-bypassed) single-company balance view it stops the aggregate from
  // scanning the whole platform ledger; under company RLS it's a redundant
  // no-op. Per-operation sums are identical to the correlated form because every
  // ledger row of an operation already shares that operation's company_id, so
  // COALESCE(la.net, 0) equals the old subquery exactly (operations with no
  // AVAILABLE entry contribute 0).
  // NOTE: this union deliberately does NOT project the notes/recipient/target
  // columns the other two builders carry — balance mode only feeds mapRow,
  // which never reads them. If ActivityItem ever starts exposing those fields,
  // add ${FLOW_RECIPIENT_SQL}/${DEPOSIT_RECIPIENT_SQL} here too, or balance-mode
  // pages will silently return undefined where normal pages have data.
  private balanceUnionSql(companyPh: string): string {
    const netJoin = (fk: string) => `LEFT JOIN (
        SELECT ${fk} AS oid,
               COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS net
        FROM ledger_entries
        WHERE account_type = 'AVAILABLE' AND ${fk} IS NOT NULL AND company_id = ${companyPh}::uuid
        GROUP BY ${fk}
      ) la ON la.oid = o.id`;
    const flowBranch = (kind: ActivityKind, table: string, fk: string) => `
      SELECT o.id, '${kind}'::text AS kind, ${moneyColsSql('fee_amount')},
             o.payout_method::text AS description,
             ${PAYOUT_DETAILS_SQL} AS details,
             o.external_reference AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             COALESCE(la.net, 0) AS net_avail
      FROM ${table} o
      LEFT JOIN companies c ON c.id = o.company_id
      ${netJoin(fk)}
      WHERE o.status = 'COMPLETED'`;
    return `
      SELECT o.id, 'DEPOSIT'::text AS kind, ${moneyColsSql('commission_amount')},
             s.code AS description,
             ${DEPOSIT_DETAILS_SQL} AS details,
             o.external_transaction_id AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             COALESCE(la.net, 0) AS net_avail
      FROM transactions o
      LEFT JOIN sources s ON s.id = o.source_id
      LEFT JOIN companies c ON c.id = o.company_id
      ${netJoin('transaction_id')}
      WHERE o.status = 'COMPLETED'
      UNION ALL${flowBranch('LOAD', 'loads', 'load_id')}
      UNION ALL${flowBranch('WITHDRAWAL', 'withdrawals', 'withdrawal_id')}
      UNION ALL${flowBranch('PAYOUT', 'payouts', 'payout_id')}
    `;
  }

  // Bounded per-branch union for the standard list: every filter AND the page's
  // top-N LIMIT are pushed INTO each operation branch, so each branch is an
  // index-ordered top-(skip+pageSize) scan (backed by the partial
  // *_completed_created_idx indexes) instead of materializing every COMPLETED row
  // and sorting the lot. Correct because any row in the global page must also rank
  // within its own branch's top-(skip+pageSize) — so merging each branch's top-N
  // and slicing the page yields exactly the same rows as the naïve plan. Filters
  // are applied to the SAME projected values the outer WHERE used (per-row
  // identical), so results match the COUNT (which still runs over the full union).
  // Every column is explicitly aliased so ANY branch can legally be the first
  // (UNION-naming) branch when kind/direction selects a subset.
  private normalRowsSql(
    dp: (v: unknown) => string,
    a: {
      query: ListActivityQuery;
      adminCompanyId: string | null;
      skip: number;
      audience: FeedAudience;
    },
  ): string {
    const q = a.query;
    // Filter placeholders — bound ONCE, reused (by $n) across every branch.
    const companyPh = a.adminCompanyId ? dp(a.adminCompanyId) : null;
    const currencyPh = q.currency ? dp(q.currency) : null;
    const fromPh = q.from ? dp(new Date(q.from)) : null;
    const toPh = q.to ? dp(new Date(q.to)) : null;
    const search = searchPh(q.search, dp);
    const limPh = dp(a.skip + q.pageSize);

    // `searchClause` — the row matches the search (common/search.ts: every
    // field, incl. the internal id so a code copied from an audit log or any
    // detail panel is findable straight from the search box).
    const branchWhere = (searchClause: string): string => {
      const cl = [`o.status = 'COMPLETED'`];
      if (companyPh) cl.push(`o.company_id = ${companyPh}::uuid`);
      if (currencyPh) cl.push(`o.currency = ${currencyPh}`);
      if (fromPh) cl.push(`o.created_at >= ${fromPh}`);
      if (toPh) cl.push(`o.created_at <= ${toPh}`);
      return cl.join(' AND ') + searchClause;
    };

    // The three money-out/-in tables share an identical projection shape.
    const flowBranch = (kind: ActivityKind, table: string): string => `(
      SELECT o.id, '${kind}'::text AS kind, ${moneyColsSql('fee_amount')},
             o.payout_method::text AS description,
             ${PAYOUT_DETAILS_SQL} AS details,
             o.external_reference AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             o.notes, o.admin_notes,
             ${FLOW_RECIPIENT_SQL}
      FROM ${table} o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE ${branchWhere(flowSearchClause(search))}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limPh}
    )`;

    const branches: Record<ActivityKind, string> = {
      DEPOSIT: `(
      SELECT o.id, 'DEPOSIT'::text AS kind, ${moneyColsSql('commission_amount', depositAmountSql(a.audience))},
             s.code AS description,
             ${DEPOSIT_DETAILS_SQL} AS details,
             o.external_transaction_id AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             ${DEPOSIT_RECIPIENT_SQL}
      FROM transactions o
      LEFT JOIN sources s ON s.id = o.source_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE ${branchWhere(depositSearchClause(search))}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limPh}
    )`,
      LOAD: flowBranch('LOAD', 'loads'),
      WITHDRAWAL: flowBranch('WITHDRAWAL', 'withdrawals'),
      PAYOUT: flowBranch('PAYOUT', 'payouts'),
    };

    // Branch selection mirrors the old outer WHERE on u.kind: a kind filter keeps
    // one branch; a direction filter keeps that direction's branches; else all.
    const allKinds = Object.keys(branches) as ActivityKind[];
    const kinds = q.kind
      ? [q.kind]
      : q.direction
        ? allKinds.filter((k) => ACTIVITY_DIRECTION[k] === q.direction)
        : allKinds;

    return kinds.map((k) => branches[k]).join('\n      UNION ALL\n');
  }

  // Standard paginated list (no running balance). Company scope is enforced by
  // RLS; an admin may narrow to one company. Filters bind as params only.
  private async queryNormal(
    tx: PrismaClient,
    a: {
      query: ListActivityQuery;
      adminCompanyId: string | null;
      skip: number;
      countScope: string;
      audience: FeedAudience;
    },
  ): Promise<{ rows: ActivityRow[]; total: number }> {
    // COUNT filters — applied to the full union's projected columns. Unchanged:
    // the COUNT runs over the whole union (it can't early-stop) and is 30s-cached,
    // so it isn't the per-keystroke hot path the bounded rows query optimizes.
    const where = (p: (v: unknown) => string): string => {
      const cl: string[] = [];
      if (a.adminCompanyId) cl.push(`u.company_id = ${p(a.adminCompanyId)}::uuid`);
      if (a.query.direction) cl.push(`u.kind IN (${this.kindsFor(a.query.direction, p)})`);
      if (a.query.kind) cl.push(`u.kind = ${p(a.query.kind)}`);
      if (a.query.currency) cl.push(`u.currency = ${p(a.query.currency)}`);
      if (a.query.from) cl.push(`u.created_at >= ${p(new Date(a.query.from))}`);
      if (a.query.to) cl.push(`u.created_at <= ${p(new Date(a.query.to))}`);
      // The search is applied inside the union (unionSql) — see below.
      return cl.length ? `WHERE ${cl.join(' AND ')}` : '';
    };

    const dataParams: unknown[] = [];
    const dp = (v: unknown) => (dataParams.push(v), `$${dataParams.length}`);
    const unionRows = this.normalRowsSql(dp, a);
    const limit = dp(a.query.pageSize);
    const offset = dp(a.skip);
    const rows = await tx.$queryRawUnsafe<ActivityRow[]>(
      `SELECT * FROM (${unionRows}) u
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...dataParams,
    );

    const total = await this.cachedCount(a.countScope, a.query, a.adminCompanyId, null, () => {
      const cp: unknown[] = [];
      const p = (v: unknown) => (cp.push(v), `$${cp.length}`);
      const whereCount = where(p);
      const union = this.unionSql({ backoffice: false }, searchPh(a.query.search, p));
      return tx
        .$queryRawUnsafe<
          Array<{ n: bigint }>
        >(`SELECT COUNT(*)::bigint AS n FROM (${union}) u ${whereCount}`, ...cp)
        .then((r) => Number(r[0]?.n ?? 0));
    });

    return { rows, total };
  }

  // Single-company, single-currency list WITH an absolute running AVAILABLE
  // balance per row. The window SUM runs over the company's whole COMPLETED
  // history for that currency (so the balance is absolute, not page-relative);
  // the date filter is applied afterwards. The newest row reconciles exactly to
  // wallets.available_balance in normal operation — the only divergence is a
  // partial reversal clawback (a REVERSED txn whose debit exceeded available and
  // booked a RECEIVABLE), which is excluded here; that is rare and self-corrects
  // as new completed ops arrive.
  private async queryBalanceMode(
    tx: PrismaClient,
    a: {
      query: ListActivityQuery;
      companyId: string;
      currency: string;
      skip: number;
      countScope: string;
    },
  ): Promise<{ rows: ActivityRow[]; total: number }> {
    const dataParams: unknown[] = [];
    const dp = (v: unknown) => (dataParams.push(v), `$${dataParams.length}`);
    const companyP = dp(a.companyId);
    const currencyP = dp(a.currency);
    const dateCl: string[] = [];
    if (a.query.from) dateCl.push(`created_at >= ${dp(new Date(a.query.from))}`);
    if (a.query.to) dateCl.push(`created_at <= ${dp(new Date(a.query.to))}`);
    const whereDate = dateCl.length ? `WHERE ${dateCl.join(' AND ')}` : '';
    const limit = dp(a.query.pageSize);
    const offset = dp(a.skip);

    const rows = await tx.$queryRawUnsafe<ActivityRow[]>(
      `WITH u AS (${this.balanceUnionSql(companyP)}),
            ranked AS (
              SELECT u.*,
                     SUM(u.net_avail) OVER (ORDER BY u.created_at ASC, u.id ASC)::text AS balance_after
              FROM u
              WHERE u.company_id = ${companyP}::uuid AND u.currency = ${currencyP}
            )
       SELECT * FROM ranked
       ${whereDate}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...dataParams,
    );

    const total = await this.cachedCount(a.countScope, a.query, a.companyId, a.currency, () => {
      const cp: unknown[] = [];
      const p = (v: unknown) => (cp.push(v), `$${cp.length}`);
      const cl = [`u.company_id = ${p(a.companyId)}::uuid`, `u.currency = ${p(a.currency)}`];
      if (a.query.from) cl.push(`u.created_at >= ${p(new Date(a.query.from))}`);
      if (a.query.to) cl.push(`u.created_at <= ${p(new Date(a.query.to))}`);
      return tx
        .$queryRawUnsafe<
          Array<{ n: bigint }>
        >(`SELECT COUNT(*)::bigint AS n FROM (${this.unionSql()}) u WHERE ${cl.join(' AND ')}`, ...cp)
        .then((r) => Number(r[0]?.n ?? 0));
    });

    return { rows, total };
  }

  // IN = deposit + load, OUT = withdrawal + payout — bound as params.
  private kindsFor(direction: 'IN' | 'OUT', p: (v: unknown) => string): string {
    const kinds = (Object.keys(ACTIVITY_DIRECTION) as ActivityKind[]).filter(
      (k) => ACTIVITY_DIRECTION[k] === direction,
    );
    return kinds.map((k) => p(k)).join(', ');
  }

  // Total COMPLETED ops for a (company, currency), unfiltered — used only to
  // decide whether balance mode is feasible (bounded). Cached briefly.
  private completedCount(tx: PrismaClient, companyId: string, currency: string): Promise<number> {
    return this.cache.wrap(
      `activity-history-count:${companyId}:${currency}`,
      LIST_COUNT_CACHE_TTL_SEC,
      () =>
        tx
          .$queryRawUnsafe<
            Array<{ n: bigint }>
          >(`SELECT COUNT(*)::bigint AS n FROM (${this.unionSql()}) u WHERE u.company_id = $1::uuid AND u.currency = $2`, companyId, currency)
          .then((r) => Number(r[0]?.n ?? 0)),
      // singleFlight:false — runs inside the caller's tx; compute-on-miss.
      { singleFlight: false },
    );
  }

  // `scope` is whose rows the count query can SEE (one tenant under RLS, or
  // everything for an admin). It leads the key so a count is only ever reused
  // by callers with the same visibility: without it, two tenants asking the
  // same filtered question — or a tenant and the platform-wide admin view —
  // would share one cached total.
  private cachedCount(
    scope: string,
    query: ListActivityQuery,
    companyId: string | null,
    currency: string | null,
    run: () => Promise<number>,
  ): Promise<number> {
    const key =
      `list-count:activity:${scope}:${companyId ?? 'all'}:${currency ?? query.currency ?? ''}` +
      `:${query.direction ?? ''}:${query.kind ?? ''}:${query.from ?? ''}:${query.to ?? ''}:${query.search ?? ''}`;
    // singleFlight:false — runs inside the caller's tx; compute-on-miss.
    return this.cache.wrap(key, LIST_COUNT_CACHE_TTL_SEC, run, { singleFlight: false });
  }

  private mapRow(r: ActivityRow, isCompanyScope: boolean, balanceMode: boolean): ActivityItem {
    return {
      id: r.id,
      kind: r.kind,
      direction: ACTIVITY_DIRECTION[r.kind],
      amount: r.amount,
      currency: r.currency,
      fee: r.fee,
      networkFee: r.network_fee,
      net: r.net,
      description: r.description ?? r.kind,
      details: r.details ?? null,
      reference: r.reference ?? null,
      createdAt: r.created_at.toISOString(),
      completedAt: r.processed_at ? r.processed_at.toISOString() : null,
      // The company feed is single-tenant — its own name is noise.
      companyId: isCompanyScope ? null : r.company_id,
      companyName: isCompanyScope ? null : (r.company_name ?? null),
      balanceAfter: balanceMode ? (r.balance_after ?? null) : null,
    };
  }
}
