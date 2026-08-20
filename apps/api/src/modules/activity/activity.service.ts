import { Injectable, StreamableFile } from '@nestjs/common';
import {
  ACTIVITY_DIRECTION,
  SUPPORTED_CURRENCIES,
  type ActivityItem,
  type ActivityKind,
  type ActivityListResponse,
  type ListActivityQuery,
  type PendingCounts,
} from '@app/shared';
import type { PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { ValidationError } from '../../common/errors/domain.error';
import { streamCsvKeyset } from '../../common/csv';

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
// `amount` is always the GROSS money that actually moved (net + fee) — never
// the bare requested figure, whose meaning flips with fee_application.
interface ActivityRow {
  id: string;
  kind: ActivityKind;
  amount: string;
  currency: string;
  fee: string;
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

/**
 * Read-only unified activity feed across the four money operations
 * (deposit/load/withdrawal/payout), COMPLETED only. A raw UNION ALL keeps it a
 * single paginated, chronologically-merged list; RLS (via runAsScoped) isolates
 * company callers while admins see everything. Nothing here mutates money.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async list(args: {
    companyId?: string;
    query: ListActivityQuery;
  }): Promise<ActivityListResponse> {
    const { query } = args;
    const skip = (query.page - 1) * query.pageSize;
    if (skip > MAX_LIST_OFFSET) {
      throw new ValidationError(
        'Page too deep to scan efficiently. Narrow the results with filters (date range, type, direction).',
      );
    }

    // Resolve the company the feed is scoped to: the caller's own (company
    // scope) or the admin's optional companyId filter.
    const scopedCompanyId = args.companyId ?? query.companyId ?? null;
    const isCompanyScope = Boolean(args.companyId);

    // Running balance ("balance mode") is only well-defined for a single
    // company + single currency, with no kind/direction/search filter that
    // would punch holes in the chronological sum. A date filter is still fine —
    // it's applied AFTER the cumulative window so balances stay absolute.
    const onlyCurrency = SUPPORTED_CURRENCIES.length === 1 ? SUPPORTED_CURRENCIES[0] : null;
    const effectiveCurrency = query.currency ?? onlyCurrency ?? null;
    const balanceMode =
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
          })
        : await this.queryNormal(tx, { query, adminCompanyId: query.companyId ?? null, skip });

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
  streamCsv(args: { companyId?: string; query: ListActivityQuery }): StreamableFile {
    const scope = args.companyId ?? null;
    // Admins may narrow to one company; company callers are already RLS-scoped.
    const adminCompanyId = args.companyId ? null : (args.query.companyId ?? null);
    const q = args.query;
    const prisma = this.prisma;
    const unionSql = this.unionSql();
    const kindsFor = this.kindsFor.bind(this);

    return streamCsvKeyset<ActivityRow>({
      filename: `transactions-${Date.now()}.csv`,
      header: [
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
      ],
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
          if (q.search) {
            const like = p(`%${q.search}%`);
            // Match the human reference/name fields AND the internal id, so a
            // code copied from an audit log finds its row.
            cl.push(
              `(u.reference ILIKE ${like} OR u.description ILIKE ${like} OR u.details ILIKE ${like} OR u.id::text ILIKE ${like})`,
            );
          }
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
      toCells: (r) => [
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
      ],
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
  // `amount` is the GROSS that actually moved. Every table's bare `amount` is the
  // requested figure (gross for DEDUCTED fees but net for ON_TOP), so it is always
  // recomputed as net + fee — an identity that holds under both fee applications
  // and needs no fee_application column (deposits don't have one).
  private unionSql(): string {
    return `
      SELECT o.id, 'DEPOSIT'::text AS kind, (o.net_amount + o.commission_amount)::text AS amount, o.currency,
             o.commission_amount::text AS fee, o.net_amount::text AS net,
             NULL::text AS fee_application,
             s.code AS description,
             COALESCE(o.payload->>'customer', o.payload->>'target', o.payload->>'phone') AS details,
             o.external_transaction_id AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             o.payload->>'note' AS notes, NULL::text AS admin_notes,
             o.payload->>'customer' AS recipient_name, o.payload->>'phone' AS recipient_contact,
             o.payload->>'target' AS target
      FROM transactions o
      LEFT JOIN sources s ON s.id = o.source_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'
      UNION ALL
      SELECT o.id, 'LOAD'::text, (o.net_amount + o.fee_amount)::text, o.currency,
             o.fee_amount::text, o.net_amount::text,
             o.fee_application::text,
             o.payout_method::text,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'walletAddress', o.payout_details->>'description',
                      o.external_reference),
             o.external_reference,
             o.created_at, o.processed_at, o.company_id, c.name, o.notes, o.admin_notes,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'network', o.payout_details->>'description') AS recipient_name,
             COALESCE(o.payout_details->>'recipientPhone', o.payout_details->>'walletAddress',
                      o.payout_details->>'accountNumber', o.payout_details->>'bankName') AS recipient_contact,
             NULL::text AS target
      FROM loads o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'
      UNION ALL
      SELECT o.id, 'WITHDRAWAL'::text, (o.net_amount + o.fee_amount)::text, o.currency,
             o.fee_amount::text, o.net_amount::text,
             o.fee_application::text,
             o.payout_method::text,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'walletAddress', o.payout_details->>'description',
                      o.external_reference),
             o.external_reference,
             o.created_at, o.processed_at, o.company_id, c.name, o.notes, o.admin_notes,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'network', o.payout_details->>'description') AS recipient_name,
             COALESCE(o.payout_details->>'recipientPhone', o.payout_details->>'walletAddress',
                      o.payout_details->>'accountNumber', o.payout_details->>'bankName') AS recipient_contact,
             NULL::text AS target
      FROM withdrawals o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'
      UNION ALL
      SELECT o.id, 'PAYOUT'::text, (o.net_amount + o.fee_amount)::text, o.currency,
             o.fee_amount::text, o.net_amount::text,
             o.fee_application::text,
             o.payout_method::text,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'walletAddress', o.payout_details->>'description',
                      o.external_reference),
             o.external_reference,
             o.created_at, o.processed_at, o.company_id, c.name, o.notes, o.admin_notes,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'network', o.payout_details->>'description') AS recipient_name,
             COALESCE(o.payout_details->>'recipientPhone', o.payout_details->>'walletAddress',
                      o.payout_details->>'accountNumber', o.payout_details->>'bankName') AS recipient_contact,
             NULL::text AS target
      FROM payouts o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status = 'COMPLETED'
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
  private balanceUnionSql(companyPh: string): string {
    const netJoin = (fk: string) => `LEFT JOIN (
        SELECT ${fk} AS oid,
               COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS net
        FROM ledger_entries
        WHERE account_type = 'AVAILABLE' AND ${fk} IS NOT NULL AND company_id = ${companyPh}::uuid
        GROUP BY ${fk}
      ) la ON la.oid = o.id`;
    const PAYOUT_DETAILS = `COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder', o.payout_details->>'walletAddress', o.payout_details->>'description', o.external_reference)`;
    const flowBranch = (kind: ActivityKind, table: string, fk: string) => `
      SELECT o.id, '${kind}'::text AS kind, (o.net_amount + o.fee_amount)::text AS amount, o.currency,
             o.fee_amount::text AS fee, o.net_amount::text AS net,
             o.payout_method::text AS description,
             ${PAYOUT_DETAILS} AS details,
             o.external_reference AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             COALESCE(la.net, 0) AS net_avail
      FROM ${table} o
      LEFT JOIN companies c ON c.id = o.company_id
      ${netJoin(fk)}
      WHERE o.status = 'COMPLETED'`;
    return `
      SELECT o.id, 'DEPOSIT'::text AS kind, (o.net_amount + o.commission_amount)::text AS amount, o.currency,
             o.commission_amount::text AS fee, o.net_amount::text AS net,
             s.code AS description,
             COALESCE(o.payload->>'customer', o.payload->>'target', o.payload->>'phone') AS details,
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
    a: { query: ListActivityQuery; adminCompanyId: string | null; skip: number },
  ): string {
    const q = a.query;
    // Filter placeholders — bound ONCE, reused (by $n) across every branch.
    const companyPh = a.adminCompanyId ? dp(a.adminCompanyId) : null;
    const currencyPh = q.currency ? dp(q.currency) : null;
    const fromPh = q.from ? dp(new Date(q.from)) : null;
    const toPh = q.to ? dp(new Date(q.to)) : null;
    const likePh = q.search ? dp(`%${q.search}%`) : null;
    const limPh = dp(a.skip + q.pageSize);

    const branchWhere = (ref: string, desc: string, details: string): string => {
      const cl = [`o.status = 'COMPLETED'`];
      if (companyPh) cl.push(`o.company_id = ${companyPh}::uuid`);
      if (currencyPh) cl.push(`o.currency = ${currencyPh}`);
      if (fromPh) cl.push(`o.created_at >= ${fromPh}`);
      if (toPh) cl.push(`o.created_at <= ${toPh}`);
      if (likePh) {
        // Also match the internal id so a code copied from an audit log (or any
        // detail panel) is findable straight from the search box.
        cl.push(
          `(${ref} ILIKE ${likePh} OR ${desc} ILIKE ${likePh} OR ${details} ILIKE ${likePh} OR o.id::text ILIKE ${likePh})`,
        );
      }
      return cl.join(' AND ');
    };

    const PAYOUT_DETAILS = `COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder', o.payout_details->>'walletAddress', o.payout_details->>'description', o.external_reference)`;
    // The three money-out/-in tables share an identical projection shape.
    // Gross (net + fee), not the bare requested amount — see unionSql().
    const flowBranch = (kind: ActivityKind, table: string): string => `(
      SELECT o.id, '${kind}'::text AS kind, (o.net_amount + o.fee_amount)::text AS amount, o.currency,
             o.fee_amount::text AS fee, o.net_amount::text AS net,
             o.payout_method::text AS description,
             ${PAYOUT_DETAILS} AS details,
             o.external_reference AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             o.notes, o.admin_notes,
             COALESCE(o.payout_details->>'recipientName', o.payout_details->>'accountHolder',
                      o.payout_details->>'network', o.payout_details->>'description') AS recipient_name,
             COALESCE(o.payout_details->>'recipientPhone', o.payout_details->>'walletAddress',
                      o.payout_details->>'accountNumber', o.payout_details->>'bankName') AS recipient_contact,
             NULL::text AS target
      FROM ${table} o
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE ${branchWhere('o.external_reference', 'o.payout_method::text', PAYOUT_DETAILS)}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limPh}
    )`;

    const branches: Record<ActivityKind, string> = {
      DEPOSIT: `(
      SELECT o.id, 'DEPOSIT'::text AS kind, (o.net_amount + o.commission_amount)::text AS amount, o.currency,
             o.commission_amount::text AS fee, o.net_amount::text AS net,
             s.code AS description,
             COALESCE(o.payload->>'customer', o.payload->>'target', o.payload->>'phone') AS details,
             o.external_transaction_id AS reference,
             o.created_at, o.processed_at, o.company_id, c.name AS company_name,
             o.payload->>'note' AS notes, NULL::text AS admin_notes,
             o.payload->>'customer' AS recipient_name, o.payload->>'phone' AS recipient_contact,
             o.payload->>'target' AS target
      FROM transactions o
      LEFT JOIN sources s ON s.id = o.source_id
      LEFT JOIN companies c ON c.id = o.company_id
      WHERE ${branchWhere(`o.external_transaction_id`, `s.code`, `COALESCE(o.payload->>'customer', o.payload->>'target', o.payload->>'phone')`)}
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
    a: { query: ListActivityQuery; adminCompanyId: string | null; skip: number },
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
      if (a.query.search) {
        const like = p(`%${a.query.search}%`);
        cl.push(
          `(u.reference ILIKE ${like} OR u.description ILIKE ${like} OR u.details ILIKE ${like} OR u.id::text ILIKE ${like})`,
        );
      }
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

    const total = await this.cachedCount(a.query, a.adminCompanyId, null, () => {
      const cp: unknown[] = [];
      const p = (v: unknown) => (cp.push(v), `$${cp.length}`);
      const whereCount = where(p);
      return tx
        .$queryRawUnsafe<
          Array<{ n: bigint }>
        >(`SELECT COUNT(*)::bigint AS n FROM (${this.unionSql()}) u ${whereCount}`, ...cp)
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
    a: { query: ListActivityQuery; companyId: string; currency: string; skip: number },
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

    const total = await this.cachedCount(a.query, a.companyId, a.currency, () => {
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

  private cachedCount(
    query: ListActivityQuery,
    companyId: string | null,
    currency: string | null,
    run: () => Promise<number>,
  ): Promise<number> {
    const key =
      `list-count:activity:${companyId ?? 'all'}:${currency ?? query.currency ?? ''}` +
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
