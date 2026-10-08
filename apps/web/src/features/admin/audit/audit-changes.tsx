'use client';
import {
  auditChangesOf,
  CommissionType,
  FEE_OPERATION_LABEL,
  FEE_OPERATION_TYPES,
  type FeeOperationType,
} from '@app/shared';
import { formatNetworkFeeRate } from '@/features/admin/companies/network-fee-draft';

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
  networkFeeEnabled: 'Network fee',
};

const MAX_LEN = 40;

// A network-fee save records one change per flow as `networkFee.<FLOW>`, whose
// values are "PERCENTAGE 1" / "FIXED 2", or null for a flow that isn't charged.
const NETWORK_FEE_FIELD = 'networkFee.';

function networkFeeOperation(field: string): FeeOperationType | null {
  if (!field.startsWith(NETWORK_FEE_FIELD)) return null;
  const op = field.slice(NETWORK_FEE_FIELD.length);
  return (FEE_OPERATION_TYPES as ReadonlyArray<string>).includes(op)
    ? (op as FeeOperationType)
    : null;
}

function fieldLabel(field: string): string {
  const op = networkFeeOperation(field);
  if (op) return `Network fee · ${FEE_OPERATION_LABEL[op]}`;
  return FIELD_LABEL[field] ?? field;
}

export function AuditChangesCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  const changes = auditChangesOf(metadata);
  if (!changes) return <span className="text-muted-foreground">—</span>;

  return (
    <ul className="space-y-0.5 text-xs">
      {Object.entries(changes).map(([field, { from, to }]) => {
        const rate = networkFeeOperation(field) !== null;
        return (
          <li key={field}>
            <span className="text-muted-foreground">{fieldLabel(field)}: </span>
            <Scalar value={from} rate={rate} className="line-through opacity-60" />
            <span className="mx-1">→</span>
            <Scalar value={to} rate={rate} />
          </li>
        );
      })}
    </ul>
  );
}

function Scalar({
  value,
  rate = false,
  className = '',
}: {
  value: string | number | boolean | null;
  // A network-fee rate: rendered as "1%" / "$2.00", null as "not charged".
  rate?: boolean;
  className?: string;
}) {
  const text = rate ? formatRate(value) : format(value);
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

// "PERCENTAGE 0.125" → "0.125%" (a rate keeps its precision); "FIXED 2" →
// "$2.00" (an amount, in cents) — exactly as the company's Network fee card
// reads. Anything unrecognised renders as recorded.
function formatRate(value: string | number | boolean | null): string {
  if (value === null || value === '') return 'not charged';
  if (typeof value !== 'string') return format(value);
  const [type, amount] = value.split(' ');
  if ((type === CommissionType.PERCENTAGE || type === CommissionType.FIXED) && amount) {
    return formatNetworkFeeRate(type, amount);
  }
  return value;
}
