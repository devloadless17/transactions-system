/**
 * Wording for the "needs attention" alerts (sidebar, banners, Overview): how
 * long money has been waiting for a person, in words an operator reads at a
 * glance ("for 12 days").
 */
export function heldForText(sinceIso: string | null, now: Date = new Date()): string | null {
  if (!sinceIso) return null;
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `for ${plural(Math.max(1, minutes), 'minute')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `for ${plural(hours, 'hour')}`;
  return `for ${plural(Math.floor(hours / 24), 'day')}`;
}

/** "1 withdrawal" / "3 withdrawals". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
