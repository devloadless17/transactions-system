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
 * Locale-grouped display of a decimal string (e.g. "1234.5" → "1,234.5").
 * Values ≥ 1 are grouped and capped at 2 fraction digits; sub-1 values keep
 * their full precision; non-numeric input is passed through unchanged.
 */
export function formatNumber(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toString();
}
