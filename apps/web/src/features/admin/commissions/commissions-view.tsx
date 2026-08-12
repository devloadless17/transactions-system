'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { Building2, Layers, Pencil, Trash2 } from 'lucide-react';
import { FEE_OPERATION_LABEL } from '@app/shared';
import type { CommissionRuleGroupResponse, CompanyResponse, PaginatedResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { CommissionRuleDialog } from './commission-rule-dialog';

const PAGE_SIZE = 20;

export function CommissionsView({ canDelete = false }: { canDelete?: boolean }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CommissionRuleGroupResponse | null>(null);
  const [page, setPage] = useState(1);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'commission-rules'] });

  const rulesQ = useQuery({
    queryKey: ['admin', 'commission-rules', { page }],
    queryFn: () =>
      apiFetch<PaginatedResponse<CommissionRuleGroupResponse>>(
        `/admin/commission-rules?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });
  const companiesQ = useQuery({
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => apiFetch<PaginatedResponse<CompanyResponse>>('/admin/companies?pageSize=100'),
  });
  const companies = companiesQ.data?.data ?? [];
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

  const setActiveMu = useMutation({
    mutationFn: ({ groupId, active }: { groupId: string; active: boolean }) =>
      apiFetch(`/admin/commission-rules/${groupId}/${active ? 'activate' : 'deactivate'}`, {
        method: 'POST',
      }),
    onSuccess: (_d, v) => {
      toast.success(v.active ? 'Rule enabled' : 'Rule disabled');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const deleteMu = useMutation({
    mutationFn: (groupId: string) =>
      apiFetch(`/admin/commission-rules/${groupId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Rule deleted');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const groups = rulesQ.data?.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Commission Rules</h1>
          <p className="text-sm text-muted-foreground">
            Each rule applies fee tiers to chosen companies and operations. The most specific
            company wins, then the highest priority.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New rule
        </Button>
      </div>

      {rulesQ.isLoading ? (
        <SkeletonState />
      ) : rulesQ.error ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-destructive">
            Failed to load rules.
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Layers className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No commission rules yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Create one rule and apply it to many companies and operations at once.
            </p>
            <Button className="mt-1" onClick={() => setCreateOpen(true)}>
              New rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <RuleCard
              key={g.groupId}
              group={g}
              companyNameById={companyNameById}
              canDelete={canDelete}
              busy={setActiveMu.isPending || deleteMu.isPending}
              onEdit={() => setEditing(g)}
              onToggleActive={() => setActiveMu.mutate({ groupId: g.groupId, active: !g.active })}
              onDelete={() => {
                if (confirm('Delete this rule permanently? This cannot be undone.')) {
                  deleteMu.mutate(g.groupId);
                }
              }}
            />
          ))}
        </div>
      )}

      {rulesQ.data && rulesQ.data.meta.totalPages > 1 && (
        <Pagination
          page={rulesQ.data.meta.page}
          totalPages={rulesQ.data.meta.totalPages}
          total={rulesQ.data.meta.total}
          onPageChange={setPage}
        />
      )}

      <CommissionRuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        companies={companies}
        onSaved={() => {
          setCreateOpen(false);
          void rulesQ.refetch();
        }}
      />
      <CommissionRuleDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        companies={companies}
        group={editing}
        onSaved={() => {
          setEditing(null);
          void rulesQ.refetch();
        }}
      />
    </div>
  );
}

function RuleCard({
  group,
  companyNameById,
  canDelete,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  group: CommissionRuleGroupResponse;
  companyNameById: Map<string, string>;
  canDelete: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const companies = companySummary(group, companyNameById);
  const title = group.name?.trim() || companies;
  // Avoid repeating the company summary in the subtitle when it's already the title.
  const metaParts = [
    ...(group.name?.trim() ? [companies] : []),
    // Each operation with its own application, e.g. "Deposits (deducted), Withdrawals (on top)".
    group.operations
      .map(
        (o) =>
          `${FEE_OPERATION_LABEL[o.operationType]} (${o.feeApplication === 'ON_TOP' ? 'on top' : 'deducted'})`,
      )
      .join(', '),
    `priority ${group.priority}`,
  ];
  // Every operation charges the same ladder → render it once (the common case);
  // otherwise one labeled ladder per operation.
  const firstOp = group.operations[0];
  const sameLadder =
    firstOp !== undefined &&
    group.operations.every((o) => ladderKey(o.tiers) === ladderKey(firstOp.tiers));

  return (
    <Card className={`overflow-hidden transition-colors ${group.active ? '' : 'bg-muted/30'}`}>
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${group.active ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
              />
              <h3 className="truncate text-base font-semibold leading-tight">{title}</h3>
            </div>
            <p className="flex items-center gap-1.5 truncate pl-4 text-xs text-muted-foreground">
              <Building2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{metaParts.join('  ·  ')}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              checked={group.active}
              disabled={busy}
              onCheckedChange={onToggleActive}
              aria-label={group.active ? 'Disable rule' : 'Enable rule'}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Edit rule"
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label="Delete rule"
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Tier ladder(s): one when shared across operations, else one per operation */}
        {sameLadder ? (
          <div className="border-t bg-muted/20">
            <TierTable tiers={firstOp.tiers} />
          </div>
        ) : (
          <div className="divide-y border-t bg-muted/20">
            {group.operations.map((o) => (
              <div key={o.operationType}>
                <p className="px-4 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">
                  {FEE_OPERATION_LABEL[o.operationType]} ·{' '}
                  {o.feeApplication === 'ON_TOP' ? 'on top' : 'deducted'}
                </p>
                <TierTable tiers={o.tiers} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ResponseTier = CommissionRuleGroupResponse['operations'][number]['tiers'][number];

/** Canonical fingerprint of a ladder, for the shared-vs-per-operation display split. */
function ladderKey(tiers: ResponseTier[]): string {
  return tiers
    .map((t) => `${t.minAmount}|${t.maxAmount ?? '∞'}|${t.commissionType}|${t.commissionValue}`)
    .join(';');
}

function TierTable({ tiers }: { tiers: ResponseTier[] }) {
  return (
    <table className="w-full">
      <tbody className="divide-y divide-border/60">
        {tiers.map((t, i) => {
          const next = tiers[i + 1];
          return (
            <tr key={i}>
              <td className="px-4 py-2 text-sm text-muted-foreground">
                {rangeLabel(t, next?.minAmount ?? null, tiers.length)}
              </td>
              <td className="px-4 py-2 text-right text-sm font-medium tabular-nums">
                {feeLabel(t.commissionType, t.commissionValue)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SkeletonState() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-4">
            <div className="h-4 w-44 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function companySummary(group: CommissionRuleGroupResponse, nameById: Map<string, string>): string {
  if (group.companyIds === null) return 'All companies';
  const names = group.companyIds.map((id) => nameById.get(id) ?? '…');
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** A tier BOUND is money: cents, like every other amount on the platform. */
function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
}

/**
 * A PERCENTAGE value is a RATE, not money — it keeps its precision, so a real
 * 0.125% price renders as "0.125%" instead of being rounded to "0.13%".
 */
function fmtRate(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);
}

/**
 * Threshold ranges: each tier runs from its min up to the next tier's start;
 * the top tier (null max) is open-ended.
 */
function rangeLabel(tier: ResponseTier, nextMin: string | null, count: number): string {
  const min = tier.minAmount;
  const zeroMin = Number(min) === 0;
  if (tier.maxAmount === null) {
    if (count === 1 && zeroMin) return 'Any amount';
    return `${fmtAmount(min)} and above`;
  }
  const high = nextMin ?? tier.maxAmount;
  if (zeroMin) return `Up to ${fmtAmount(high)}`;
  return `${fmtAmount(min)} – ${fmtAmount(high)}`;
}

function feeLabel(type: string, value: string): string {
  return type === 'PERCENTAGE' ? `${fmtRate(value)}%` : `$${fmtAmount(value)}`;
}
