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
 * Predicates are SQL over the row alias `o`; values are bound through the
 * caller's placeholder function, never interpolated.
 */
import { ValidationError } from './errors/domain.error';

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

/** The digits of a text column (NULL-safe), for phone matching. */
const digitsOf = (sql: string): string => `regexp_replace(COALESCE(${sql}, ''), '[^0-9]', '', 'g')`;

/**
 * A withdrawal / payout / load row (`o`) matches: its id, external reference,
 * the company's note, the payout method, or ANY value of its payout details
 * (recipient name and phone, bank account, wallet, network, pickup location…
 * whatever the method carries — so a new method is searchable with no change
 * here). Never `admin_notes`: a company searching its own rows must not be able
 * to probe what the platform wrote about them.
 */
export function flowSearchSql(likePh: string, digitsPh: string | null): string {
  const clauses = [
    `o.id::text ILIKE ${likePh}`,
    `o.external_reference ILIKE ${likePh}`,
    `o.notes ILIKE ${likePh}`,
    `o.payout_method::text ILIKE ${likePh}`,
    `EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(o.payout_details) = 'object'
               THEN o.payout_details ELSE '{}'::jsonb END) d
             WHERE d.value ILIKE ${likePh})`,
  ];
  if (digitsPh) clauses.push(`${digitsOf(`o.payout_details->>'recipientPhone'`)} LIKE ${digitsPh}`);
  return `(${clauses.join(' OR ')})`;
}

/**
 * A deposit row (`o` = transactions) matches: its id, the source's reference,
 * or the documented payload fields — customer, target, phone, note (only
 * those: nested provider objects would match their own key names). Pass the
 * source code column when the query joins `sources`, so "WHISH" finds Whish
 * deposits in the activity feed as it always has.
 */
export function depositSearchSql(
  likePh: string,
  digitsPh: string | null,
  sourceCodeSql: string | null = null,
): string {
  const clauses = [
    `o.id::text ILIKE ${likePh}`,
    `o.external_transaction_id ILIKE ${likePh}`,
    ...(sourceCodeSql ? [`${sourceCodeSql} ILIKE ${likePh}`] : []),
    ...['customer', 'target', 'phone', 'note'].map((k) => `o.payload->>'${k}' ILIKE ${likePh}`),
  ];
  if (digitsPh) {
    // The payer's phone, and `customer` — some sources send the phone there.
    clauses.push(`${digitsOf(`o.payload->>'phone'`)} LIKE ${digitsPh}`);
    clauses.push(`${digitsOf(`o.payload->>'customer'`)} LIKE ${digitsPh}`);
  }
  return `(${clauses.join(' OR ')})`;
}

/**
 * The most rows a list search narrows to before the list's own filters and
 * pagination apply (see `searchIds`). A search matching more than this is too
 * broad to mean anything — the caller asks for a few more characters.
 */
export const MAX_SEARCH_MATCHES = 10_000;

type SearchTable = 'withdrawals' | 'payouts' | 'loads' | 'transactions';

/**
 * The ids of the rows a list search matches, for a Prisma list to narrow to
 * (`where.id = { in }`) — Prisma cannot express a case-insensitive match inside
 * JSON, so the search runs here and every other filter, the sort, pagination,
 * the count and the CSV export stay exactly as they are. Runs in the caller's
 * transaction, so RLS scopes a company caller to its own rows; `companyId`
 * narrows an admin who picked one company.
 */
export async function searchIds(
  tx: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  table: SearchTable,
  raw: string,
  companyId?: string | null,
): Promise<string[]> {
  const { like, digits } = searchTerm(raw);
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const likePh = p(like);
  const digitsPh = digits ? p(digits) : null;
  const where = [
    table === 'transactions' ? depositSearchSql(likePh, digitsPh) : flowSearchSql(likePh, digitsPh),
    ...(companyId ? [`o.company_id = ${p(companyId)}::uuid`] : []),
  ].join(' AND ');
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT o.id::text AS id FROM ${table} o WHERE ${where} LIMIT ${p(MAX_SEARCH_MATCHES + 1)}`,
    ...params,
  );
  if (rows.length > MAX_SEARCH_MATCHES) {
    throw new ValidationError(
      `"${raw.trim()}" matches too many rows — type a few more characters (a full phone number, reference or name).`,
    );
  }
  return rows.map((r) => r.id);
}
