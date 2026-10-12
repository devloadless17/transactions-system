import { Money } from '@app/shared';
import type { PrismaClient } from '@app/db';

/**
 * Platform revenue, read from the ledger.
 *
 * The platform earns on two ledger accounts: FEE (the commission, plus any
 * whole-dollar rounding remainder) and NETWORK_FEE (the optional per-company
 * second fee). Each flow credits them when it settles and a reversal debits
 * them back, so the NET CREDIT of an account over a window is what was truly
 * earned in it — and it can be negative when a fee booked earlier is reversed
 * inside the window.
 *
 * Both accounts are always read by ONE statement (a UNION ALL of one SELECT per
 * account), never two:
 *   - one snapshot: these run at READ COMMITTED, where two separate statements
 *     can straddle a settlement and report its commission without its network
 *     fee (or the reverse) until the cache expires;
 *   - one copy of the window / sign / filter logic, so "Platform fees" and
 *     "Network fees" can never drift onto different windows.
 * Each SELECT names its account as a LITERAL: that is what lets the planner use
 * the account's partial index (ledger_entries_fee_currency_created_idx,
 * ledger_entries_network_fee_currency_created_idx). An `IN (...)` or a bound
 * parameter would match neither.
 */
export type RevenueAccount = 'FEE' | 'NETWORK_FEE';

export const REVENUE_ACCOUNTS: readonly RevenueAccount[] = ['FEE', 'NETWORK_FEE'];

// Net credit of an account: fees realized minus fees handed back by a reversal.
const NET_CREDIT_SQL = `SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)`;

// `accounts` is a closed TypeScript union, never user input, so writing it into
// the SQL as a literal is safe (and required — see the note above).
function perAccount(
  accounts: readonly RevenueAccount[],
  select: (account: RevenueAccount) => string,
): string {
  return accounts.map(select).join('\n      UNION ALL\n');
}

/** Net revenue per currency in a window, per account. Accounts with no rows are absent. */
export async function revenueByCurrency(
  tx: PrismaClient,
  from: Date,
  to: Date,
): Promise<Array<{ account: RevenueAccount; currency: string; total: string }>> {
  return tx.$queryRawUnsafe(
    perAccount(
      REVENUE_ACCOUNTS,
      (account) => `
      SELECT '${account}'::text AS account, currency, ${NET_CREDIT_SQL}::text AS total
      FROM ledger_entries
      WHERE account_type = '${account}'
        AND created_at >= $1 AND created_at <= $2
      GROUP BY currency`,
    ),
    from,
    to,
  );
}

/** Net revenue of one currency per time bucket, per account. Empty buckets are absent. */
export async function revenueByBucket(
  tx: PrismaClient,
  args: { currency: string; from: Date; to: Date; truncUnit: string },
): Promise<Array<{ account: RevenueAccount; day: Date; total: string }>> {
  return tx.$queryRawUnsafe(
    perAccount(
      REVENUE_ACCOUNTS,
      (account) => `
      SELECT '${account}'::text AS account,
             date_trunc($4::text, created_at AT TIME ZONE 'UTC')::date AS day,
             ${NET_CREDIT_SQL}::text AS total
      FROM ledger_entries
      WHERE account_type = '${account}'
        AND currency = $1
        AND created_at >= $2 AND created_at <= $3
      GROUP BY 2`,
    ),
    args.currency,
    args.from,
    args.to,
    args.truncUnit,
  );
}

/**
 * Net revenue of one currency in a window — optionally one company's share —
 * for the requested accounts. Every requested account is present ("0" when it
 * earned nothing); an account that was not requested is absent.
 */
export async function revenueTotals<A extends RevenueAccount>(
  tx: PrismaClient,
  args: {
    currency: string;
    from: Date;
    to: Date;
    companyId?: string | null;
    accounts: readonly A[];
  },
): Promise<Record<A, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ account: A; total: string | null }>>(
    perAccount(
      args.accounts,
      (account) => `
      SELECT '${account}'::text AS account, COALESCE(${NET_CREDIT_SQL}, 0)::text AS total
      FROM ledger_entries
      WHERE account_type = '${account}'
        AND currency = $1
        AND created_at >= $2 AND created_at <= $3
        ${args.companyId ? 'AND company_id = $4::uuid' : ''}`,
    ),
    args.currency,
    args.from,
    args.to,
    ...(args.companyId ? [args.companyId] : []),
  );
  const totals = Object.fromEntries(args.accounts.map((a) => [a, '0'])) as Record<A, string>;
  for (const r of rows) totals[r.account] = Money.of(r.total ?? '0').toString();
  return totals;
}
