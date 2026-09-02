'use client';
import { auditChangesOf } from '@app/shared';

/**
 * Renders an audit row's field-level diff as `field: old → new`.
 *
 * Audit rows previously recorded only that a mutation happened, so a rename, a
 * slug change and a visibility toggle were indistinguishable after the fact.
 * Producers now publish a diff (see the API's `recordAuditChanges`); this is the
 * only place it is read, and it deliberately renders ONLY the parsed `changes`
 * map — never the whole metadata blob, which also carries method/path/outcome.
 *
 * Unknown field names fall through to the raw key, so a route that adopts the
 * mechanism later renders sensibly here without touching this file.
 */
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  slug: 'Slug',
  status: 'Status',
  visible: 'Visible in API',
};

const MAX_LEN = 40;

export function AuditChangesCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  const changes = auditChangesOf(metadata);
  if (!changes) return <span className="text-muted-foreground">—</span>;

  return (
    <ul className="space-y-0.5 text-xs">
      {Object.entries(changes).map(([field, { from, to }]) => (
        <li key={field}>
          <span className="text-muted-foreground">{FIELD_LABEL[field] ?? field}: </span>
          <Scalar value={from} className="line-through opacity-60" />
          <span className="mx-1">→</span>
          <Scalar value={to} />
        </li>
      ))}
    </ul>
  );
}

function Scalar({
  value,
  className = '',
}: {
  value: string | number | boolean | null;
  className?: string;
}) {
  const text = format(value);
  const clipped = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}…` : text;
  return (
    <span className={`font-mono ${className}`} title={text === clipped ? undefined : text}>
      {clipped}
    </span>
  );
}

function format(value: string | number | boolean | null): string {
  if (value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
