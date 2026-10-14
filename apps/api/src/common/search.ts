/**
 * One search rule for every money list (the activity feed, deposits,
 * withdrawals, payouts, loads): what an operator types finds the row by ANY
 * field a person would quote — the reference, our id, the note, and every
 * detail of who it was for — not just the one shown as the row's title.
 *
 * - Case-insensitive substring, with `%` / `_` taken literally.
 * - A phone typed any way finds it: when the input is phone-like (digits,
 *   spaces, + - ( ) . /), its digits — leading zeros dropped, so `0096170…`,
 *   `+961 70 …` and the local `70…` / `03…` all work — are matched against the
 *   digits of the stored phone numbers.
 *
 * The fields are gathered by the SQL functions of migration
 * 20261014150000_search_text_functions, and each table has trigram indexes on
 * exactly those expressions — so these predicates are index-backed at any size
 * (measured at 27x production: a phone over 525k deposits 3.2s → 21ms). Keep
 * the calls here identical to the indexed expressions, or the index is skipped.
 *
 * Predicates are SQL over the row alias `o`; values are bound through the
 * caller's placeholder function, never interpolated.
 */

export interface SearchTerm {
  /** `%term%` for ILIKE, with LIKE wildcards in the input escaped. */
  like: string;
  /** `%digits%` when the input reads as a phone number, else null. */
  digits: string | null;
}

// Fewer digits than this would match far too much to mean "this phone".
const MIN_PHONE_DIGITS = 4;
const PHONE_LIKE = /^[\d\s+().\-/]+$/;

export function searchTerm(raw: string): SearchTerm {
  const term = raw.trim();
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = PHONE_LIKE.test(term) ? term.replace(/\D/g, '').replace(/^0+/, '') : '';
  return { like, digits: digits.length >= MIN_PHONE_DIGITS ? `%${digits}%` : null };
}

/**
 * A withdrawal / payout / load row (`o`) matches: its id, external reference,
 * the company's note, or ANY value of its payout details (recipient name and
 * phone, bank account, wallet, network, pickup location… whatever the method
 * carries). Never `admin_notes`: a company searching its own rows must not be
 * able to probe what the platform wrote about them.
 */
export function flowSearchSql(likePh: string, digitsPh: string | null): string {
  const clauses = [
    `flow_search_text(o.id, o.external_reference, o.notes, o.payout_details) ILIKE ${likePh}`,
  ];
  if (digitsPh) clauses.push(`flow_search_phones(o.payout_details) LIKE ${digitsPh}`);
  return `(${clauses.join(' OR ')})`;
}

/**
 * A deposit row (`o` = transactions) matches: its id, the source's reference,
 * or the documented payload fields — customer, target, phone, note. With
 * `sourceIdsPh` (a bound uuid[] from `matchingSourceIds`), also every deposit
 * of a source whose code matches — the activity feed has always found "WHISH"
 * deposits that way. An array, not a subquery: a subquery inside the OR would
 * stop Postgres combining the indexes.
 */
export function depositSearchSql(
  likePh: string,
  digitsPh: string | null,
  sourceIdsPh: string | null = null,
): string {
  const clauses = [
    `deposit_search_text(o.id, o.external_transaction_id, o.payload) ILIKE ${likePh}`,
  ];
  if (digitsPh) clauses.push(`deposit_search_phones(o.payload) LIKE ${digitsPh}`);
  if (sourceIdsPh) clauses.push(`o.source_id = ANY(${sourceIdsPh}::uuid[])`);
  return `(${clauses.join(' OR ')})`;
}

type RawTx = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };

/** The sources whose code matches the search (a tiny table), for `depositSearchSql`. */
export async function matchingSourceIds(tx: RawTx, raw: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text AS id FROM sources WHERE code ILIKE $1`,
    searchTerm(raw).like,
  );
  return rows.map((r) => r.id);
}

type SearchTable = 'withdrawals' | 'payouts' | 'loads' | 'transactions';

/** The list filters a searched list keeps applying (as in its Prisma `where`). */
export interface SearchListFilters {
  companyId?: string | null;
  status?: string;
  currency?: string;
  payoutMethod?: string;
  sourceId?: string;
  from?: string;
  to?: string;
}

/** `WHERE` body: the search AND every list filter, bound through `p`. */
function searchWhere(
  table: SearchTable,
  filters: SearchListFilters,
  raw: string,
  p: (v: unknown) => string,
): string {
  const { like, digits } = searchTerm(raw);
  const likePh = p(like);
  const digitsPh = digits ? p(digits) : null;
  const cl = [
    table === 'transactions' ? depositSearchSql(likePh, digitsPh) : flowSearchSql(likePh, digitsPh),
  ];
  if (filters.companyId) cl.push(`o.company_id = ${p(filters.companyId)}::uuid`);
  if (filters.status) cl.push(`o.status::text = ${p(filters.status)}`);
  if (filters.currency) cl.push(`o.currency = ${p(filters.currency)}`);
  if (filters.payoutMethod) cl.push(`o.payout_method::text = ${p(filters.payoutMethod)}`);
  if (filters.sourceId) cl.push(`o.source_id = ${p(filters.sourceId)}::uuid`);
  if (filters.from) cl.push(`o.created_at >= ${p(new Date(filters.from))}`);
  if (filters.to) cl.push(`o.created_at <= ${p(new Date(filters.to))}`);
  return cl.join(' AND ');
}

const placeholders = () => {
  const params: unknown[] = [];
  return { params, p: (v: unknown) => (params.push(v), `$${params.length}`) };
};

/**
 * A searched list's page: the matching ids in list order (newest first). The
 * list then loads those rows through Prisma exactly as it always has, so the
 * response shape and mapping are untouched. Runs in the caller's transaction:
 * RLS scopes a company caller to its own rows.
 */
export async function searchPageIds(
  tx: RawTx,
  table: SearchTable,
  filters: SearchListFilters,
  raw: string,
  skip: number,
  take: number,
): Promise<string[]> {
  const { params, p } = placeholders();
  const where = searchWhere(table, filters, raw, p);
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT o.id::text AS id FROM ${table} o WHERE ${where}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${p(take)} OFFSET ${p(skip)}`,
    ...params,
  );
  return rows.map((r) => r.id);
}

/** How many rows a searched list matches (its `meta.total`). */
export async function searchCount(
  tx: RawTx,
  table: SearchTable,
  filters: SearchListFilters,
  raw: string,
): Promise<number> {
  const { params, p } = placeholders();
  const where = searchWhere(table, filters, raw, p);
  const rows = await tx.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM ${table} o WHERE ${where}`,
    ...params,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The next chunk of a searched CSV export, keyset-paged on (created_at, id)
 * like every export: the ids after `cursor`, newest first.
 */
export async function searchKeysetIds(
  tx: RawTx,
  table: SearchTable,
  filters: SearchListFilters,
  raw: string,
  cursor: { createdAt: Date; id: string } | null,
  take: number,
): Promise<string[]> {
  const { params, p } = placeholders();
  let where = searchWhere(table, filters, raw, p);
  if (cursor) {
    const c = p(cursor.createdAt);
    where += ` AND (o.created_at < ${c} OR (o.created_at = ${c} AND o.id < ${p(cursor.id)}::uuid))`;
  }
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT o.id::text AS id FROM ${table} o WHERE ${where}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${p(take)}`,
    ...params,
  );
  return rows.map((r) => r.id);
}
