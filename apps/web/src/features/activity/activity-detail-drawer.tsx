'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type {
  ActivityItem,
  ActivityKind,
  LoadResponse,
  PayoutResponse,
  TransactionDetailResponse,
  WithdrawalResponse,
} from '@app/shared';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { apiFetch } from '@/lib/api.client';
import { cn } from '@/lib/cn';
import { formatMoney, trimAmount, isZeroAmount } from '@/lib/format';
import {
  feeApplicationLabel,
  PayoutInstructions,
  prettyMethod,
} from '@/features/company/withdrawals-view';
import { activityHeadlineAmount } from './headline-amount';

const KIND_LABEL: Record<ActivityKind, string> = {
  DEPOSIT: 'Deposit',
  LOAD: 'Load',
  WITHDRAWAL: 'Withdrawal',
  PAYOUT: 'Payout',
};
const KIND_PATH: Record<ActivityKind, string> = {
  DEPOSIT: 'transactions',
  LOAD: 'loads',
  WITHDRAWAL: 'withdrawals',
  PAYOUT: 'payouts',
};

// Payouts/loads share the withdrawal response shape (verified field-for-field).
type FlowRecord = WithdrawalResponse | PayoutResponse | LoadResponse;

/**
 * Full detail for one activity-feed row, fetched on demand by kind: deposits
 * pull the rich transaction detail (with ledger entries); withdrawals/payouts/
 * loads pull their record and reuse the same payout-instructions block the
 * dedicated pages show — so the unified feed has every detail the per-type
 * pages have.
 */
// Fetch full detail for one operation by kind + id: deposits pull the rich
// transaction detail (with ledger entries); withdrawals/payouts/loads pull their
// record. Shared by the activity-feed drawer AND the audit-log entity drawer, so
// any operation is one click from "everything about it".
export function useEntityDetailQuery(
  scope: 'admin' | 'company',
  kind: ActivityKind | undefined,
  id: string | undefined,
  enabled: boolean,
) {
  return useQuery<TransactionDetailResponse | FlowRecord>({
    queryKey: [scope, 'entity-detail', kind, id],
    enabled: enabled && !!kind && !!id,
    queryFn: () => {
      if (!kind || !id) throw new Error('no entity');
      if (kind === 'DEPOSIT') {
        return apiFetch<TransactionDetailResponse>(`/${scope}/transactions/${id}/detail`);
      }
      return apiFetch<FlowRecord>(`/${scope}/${KIND_PATH[kind]}/${id}`);
    },
  });
}

function EntityDetailBody({ q }: { q: ReturnType<typeof useEntityDetailQuery> }) {
  // Route off the SHAPE of the loaded data, never the requested `kind`. When the
  // selected item switches between a deposit and a flow (withdrawal/payout/load),
  // the `kind` prop updates synchronously while react-query's `data` can still
  // hold the previous item's record for a render — picking the renderer by `kind`
  // then feeds a FlowRecord into DepositDetail (no `.transaction` → reads
  // undefined.status) or a deposit into FlowDetail (no `totalAmount` →
  // trimAmount(undefined)), crashing the whole page into the error boundary.
  // Deposit detail is the only shape carrying a `transaction` field.
  const data = q.data;
  return (
    <>
      {q.isLoading && <div className="h-40 w-full animate-pulse rounded bg-muted" />}
      {q.isError && <p className="text-destructive">Couldn&apos;t load details — try again.</p>}
      {data &&
        ('transaction' in data ? (
          <DepositDetail d={data as TransactionDetailResponse} />
        ) : (
          <FlowDetail r={data as FlowRecord} />
        ))}
    </>
  );
}

export function ActivityDetailDrawer({
  scope,
  item,
  onClose,
}: {
  scope: 'admin' | 'company';
  item: ActivityItem | null;
  onClose: () => void;
}) {
  const q = useEntityDetailQuery(scope, item?.kind, item?.id, !!item);

  const isIn = item?.direction === 'IN';

  return (
    <Sheet open={!!item} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {item &&
              (isIn ? (
                <ArrowDownLeft className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ArrowUpRight className="h-4 w-4 text-red-600 dark:text-red-400" />
              ))}
            {item ? KIND_LABEL[item.kind] : 'Detail'}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{item?.id}</SheetDescription>
        </SheetHeader>

        {item && (
          <div className="mt-4 space-y-6 text-sm">
            <div
              className={cn(
                'text-2xl font-semibold tabular-nums',
                isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
              )}
            >
              {isIn ? '+' : '−'}
              {formatMoney(activityHeadlineAmount(item))} {item.currency}
            </div>

            <EntityDetailBody q={q} />

            {scope === 'admin' && item.companyName && (
              <Section title="Company">
                <Row label="Name" value={item.companyName} />
              </Section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// Audit-log entity types that map to a viewable money operation. Anything else
// (company, user, commission, …) has no transaction detail to open.
const AUDIT_ENTITY_KIND: Record<string, ActivityKind> = {
  transaction: 'DEPOSIT',
  load: 'LOAD',
  withdrawal: 'WITHDRAWAL',
  payout: 'PAYOUT',
};

/** Map an audit-log (entityType, entityId) to a viewable operation, or null. */
export function auditEntityTarget(
  entityType: string,
  entityId: string | null,
): { kind: ActivityKind; id: string } | null {
  const kind = AUDIT_ENTITY_KIND[entityType];
  return kind && entityId ? { kind, id: entityId } : null;
}

/**
 * Standalone detail drawer for a money operation referenced elsewhere (e.g. an
 * audit-log entity). Given a kind + id it shows the full record — the same body
 * the activity feed uses — so an operator can jump from an audit entry straight
 * to everything about that transaction.
 */
export function EntityDetailDrawer({
  scope,
  target,
  onClose,
}: {
  scope: 'admin' | 'company';
  target: { kind: ActivityKind; id: string } | null;
  onClose: () => void;
}) {
  const q = useEntityDetailQuery(scope, target?.kind, target?.id, !!target);
  return (
    <Sheet open={!!target} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{target ? KIND_LABEL[target.kind] : 'Detail'}</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">{target?.id}</SheetDescription>
        </SheetHeader>
        {target && (
          <div className="mt-4 space-y-6 text-sm">
            <EntityDetailBody q={q} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DepositDetail({ d }: { d: TransactionDetailResponse }) {
  const t = d.transaction;
  return (
    <>
      <Section title="Summary">
        <Row label="Status" value={<Badge variant="success">{t.status}</Badge>} />
        <Row label="Amount" value={`${trimAmount(t.amount)} ${t.currency}`} mono />
        {!isZeroAmount(t.commissionAmount) && (
          <Row label="Fee" value={`${trimAmount(t.commissionAmount)} ${t.currency}`} mono />
        )}
        <Row label="Net" value={`${trimAmount(t.netAmount)} ${t.currency}`} mono />
        <Row label="Source" value={t.sourceCode} />
        <Row label="External ID" value={t.externalTransactionId} mono />
        <Row label="Created" value={new Date(t.createdAt).toLocaleString()} />
        <Row
          label="Processed"
          value={t.processedAt ? new Date(t.processedAt).toLocaleString() : '—'}
        />
      </Section>

      {(t.customer || t.target || t.phone || t.note) && (
        <Section title="Details">
          {t.customer && <Row label="Customer" value={t.customer} />}
          {t.target && <Row label="Target" value={t.target} />}
          {t.phone && <Row label="Phone" value={t.phone} />}
          {t.note && <Row label="Note" value={t.note} />}
        </Section>
      )}

      {d.ledgerEntries.length > 0 && (
        <Section title="Ledger">
          {d.ledgerEntries.map((e) => (
            <Row
              key={e.id}
              label={e.accountType}
              value={
                <span className="inline-flex items-center gap-2">
                  <Badge variant={e.direction === 'CREDIT' ? 'success' : 'warning'}>
                    {e.direction}
                  </Badge>
                  <span className="font-mono">
                    {trimAmount(e.amount)} {e.currency}
                  </span>
                </span>
              }
            />
          ))}
        </Section>
      )}
    </>
  );
}

function FlowDetail({ r }: { r: FlowRecord }) {
  return (
    <>
      <Section title="Summary">
        <Row
          label="Status"
          value={
            <Badge
              variant={
                r.status === 'COMPLETED'
                  ? 'success'
                  : r.status === 'REJECTED' || r.status === 'CANCELLED'
                    ? 'destructive'
                    : 'warning'
              }
            >
              {r.status}
            </Badge>
          }
        />
        <Row label="Amount" value={`${trimAmount(r.totalAmount)} ${r.currency}`} mono />
        {!isZeroAmount(r.feeAmount) && (
          <Row
            label="Fee"
            value={`${trimAmount(r.feeAmount)} ${r.currency} (${feeApplicationLabel(r.feeApplication)})`}
            mono
          />
        )}
        <Row label="Net" value={`${trimAmount(r.netAmount)} ${r.currency}`} mono />
        <Row label="Method" value={prettyMethod(r.payoutMethod)} />
        <Row label="Requested" value={new Date(r.createdAt).toLocaleString()} />
        <Row
          label="Processed"
          value={r.processedAt ? new Date(r.processedAt).toLocaleString() : '—'}
        />
        {r.externalReference && <Row label="External reference" value={r.externalReference} mono />}
        {r.notes && <Row label="Notes" value={r.notes} />}
        {r.adminNotes && <Row label="Admin notes" value={r.adminNotes} />}
        {/* Why the last Whish auto-transfer attempt failed (e.g. recipient not found)
            — a failed transfer reverts the withdrawal to PENDING with the reason here,
            so it reads plainly instead of an unexplained back-to-manual row. */}
        {(r as WithdrawalResponse).autoApproval?.errorDetail && (
          <Row
            label="Auto-transfer note"
            value={(r as WithdrawalResponse).autoApproval!.errorDetail!}
          />
        )}
      </Section>

      <PayoutInstructions w={r as WithdrawalResponse} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b py-1 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-right text-sm', mono && 'font-mono break-all')}>{value}</span>
    </div>
  );
}
