/**
 * Money formatting helpers. Amounts arrive from the API as decimal strings and
 * must stay strings — these only format for display, never for calculation.
 */

/** Drop trailing fractional zeros: "10.500" → "10.5", "10.00" → "10". */
export function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

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
 * Full-precision money display: groups the integer part with locale separators
 * and keeps EVERY fraction digit the value carries (trailing zeros trimmed),
 * rounding NOTHING. Use this for balances and any figure a customer reconciles
 * against their real wallet — the platform money scale is 8 dp, so a 2 dp
 * rounded display could show more money than the wallet actually holds.
 * "1234.50000000" → "1,234.5"; "0.005" → "0.005"; non-numeric passes through.
 */
export function formatMoney(s: string): string {
  if (Number.isNaN(Number(s))) return s;
  const negative = s.trim().startsWith('-');
  const abs = negative ? s.trim().slice(1) : s.trim();
  const dot = abs.indexOf('.');
  const intPart = dot === -1 ? abs : abs.slice(0, dot);
  // Trailing zeros are noise, not precision — drop them, but never round.
  const fracPart = dot === -1 ? '' : abs.slice(dot + 1).replace(/0+$/, '');
  const grouped = Number(intPart || '0').toLocaleString('en-US');
  const out = fracPart ? `${grouped}.${fracPart}` : grouped;
  return negative && out !== '0' ? `-${out}` : out;
}

/**
 * Locale-grouped display of a decimal string (e.g. "1234.5" → "1,234.5"), for
 * aggregate figures (volume, counts) where 2 dp is enough. Values ≥ 1 are
 * grouped and TRUNCATED (never rounded up) to 2 fraction digits so a displayed
 * total can never exceed the real value; sub-1 values keep their full precision;
 * non-numeric input is passed through unchanged. For balances use `formatMoney`.
 */
export function formatNumber(s: string): string {
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
