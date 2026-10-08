/**
 * Money formatting helpers. Amounts arrive from the API as decimal strings and
 * must stay strings — these only format for display, never for calculation.
 */

/**
 * Truncate a decimal STRING to at most `dp` fraction digits — by slicing, never
 * by rounding, and without going through a float (so a Decimal(20,8) value can
 * never drift). "1234.999" @2 → "1234.99"; "1234" → "1234".
 */
function truncateDecimal(s: string, dp: number): string {
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  const end = dp > 0 ? dot + 1 + dp : dot;
  return s.slice(0, end);
}

/**
 * THE money formatter. Exactly 2 fraction digits, locale-grouped integer part,
 * TRUNCATED and never rounded up — a displayed figure must never claim more money
 * than the value actually holds. "1234.5" → "1,234.50"; "0.005" → "0.00";
 * non-numeric passes through, and a missing value renders "—" so a display-only
 * helper can never throw and take a page down through the error boundary.
 *
 * Once every money column is at the platform scale the truncation is a no-op; it
 * stays as the safety property for legacy rows that still carry a longer tail.
 */
export function formatAmount(s: string | null | undefined): string {
  if (typeof s !== 'string') return '—';
  const t = s.trim();
  if (t === '' || Number.isNaN(Number(t))) return s;
  const negative = t.startsWith('-');
  const abs = negative ? t.slice(1) : t;
  const [intPart = '0', fracPart = ''] = truncateDecimal(abs, 2).split('.');
  const grouped = Number(intPart || '0').toLocaleString('en-US');
  const out = `${grouped}.${(fracPart + '00').slice(0, 2)}`;
  // Sign is decided on the TRUNCATED value, not the raw one: otherwise a
  // sub-cent negative renders as the nonsense string "-0.00". (Truncating the
  // magnitude also means a negative reads slightly toward zero — deliberate:
  // an outflow shown smaller than reality is the safe direction here, the same
  // rule the positive case follows.)
  return negative && out !== '0.00' ? `-${out}` : out;
}

/**
 * True when a money STRING is zero. Use this instead of comparing a FORMATTED
 * string against '0' — the formatter now emits "0.00", so the old
 * `trimAmount(x) === '0'` sentinels silently stopped matching.
 */
export function isZeroAmount(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim() !== '' && Number(s) === 0;
}

/**
 * True only for a money STRING that parses to more than zero. The guard for a
 * figure that renders only when it was actually charged — the optional network
 * fee — so a missing value, "", "0" and "0.00" all render exactly as if the
 * field did not exist.
 */
export function isPositiveAmount(s: string | null | undefined): boolean {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t !== '' && Number(t) > 0;
}

/**
 * Display a money string EXACTLY, grouped but never rounded or padded.
 * For the append-only ledger, whose historical legs keep their original scale:
 * truncating them would make a displayed set stop tying out, the same reason the
 * ledger CSV export is exempt from cent formatting.
 */
export function formatExact(s: string | null | undefined): string {
  if (typeof s !== 'string') return '—';
  const t = s.trim();
  if (t === '' || Number.isNaN(Number(t))) return s;
  const neg = t.startsWith('-');
  const abs = neg ? t.slice(1) : t;
  const [i = '0', f = ''] = abs.split('.');
  const frac = f.replace(/0+$/, '');
  const out = `${Number(i || '0').toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
  return neg && Number(abs) !== 0 ? `-${out}` : out;
}

/** @deprecated alias of formatAmount — kept so existing call sites need no edit. */
export const trimAmount = formatAmount;
/** @deprecated alias of formatAmount. */
export const formatMoney = formatAmount;

/**
 * Locale-grouped display of a decimal string (e.g. "1234.5" → "1,234.5"), for
 * aggregate figures (volume, counts) where 2 dp is enough. Values ≥ 1 are
 * grouped and TRUNCATED (never rounded up) to 2 fraction digits so a displayed
 * total can never exceed the real value; sub-1 values keep their full precision;
 * non-numeric input is passed through unchanged. For balances use `formatMoney`.
 */
export function formatNumber(s: string | null | undefined): string {
  if (typeof s !== 'string') return '—';
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) {
    // Truncate the string to 2 dp first so toLocaleString can't round the last
    // digit up (e.g. "1250.999" must read "1,250.99", never "1,251").
    return Number(truncateDecimal(s, 2)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return n.toString();
}
