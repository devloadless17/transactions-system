'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CommissionType,
  FEE_OPERATION_LABEL,
  FEE_OPERATION_TYPES,
  type CompanyDetailResponse,
  type FeeOperationType,
  type NetworkFeeConfigResponse,
  type SetNetworkFeeConfigInput,
} from '@app/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import {
  buildInput,
  confirmSaveMessage,
  draftFromConfig,
  exampleOn100,
  formatNetworkFeeRate,
  isDirty,
  type NetworkFeeDraft,
  type NetworkFeeRateDraft,
} from './network-fee-draft';

/**
 * A company's optional network fee: a master switch plus a rate per flow
 * (deposits, withdrawals, payouts, loads), each a % or a fixed $ — or blank,
 * i.e. not charged. The switch is part of the form, so nothing applies until
 * "Save network fee". SUPER_ADMIN edits it; everyone else who can open the
 * company (ADMIN_OPERATOR) sees it read-only. The API enforces the same rule.
 */
export function NetworkFeeCard({
  companyId,
  companyName,
  config,
  canEdit,
}: {
  companyId: string;
  companyName: string;
  config: NetworkFeeConfigResponse;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<NetworkFeeDraft>(() => draftFromConfig(config));

  // Fresh server data (a refetch, or another admin's save arriving over
  // realtime) re-syncs the draft — but only while it's untouched, so a refetch
  // can never wipe what the admin is typing. Tracked during render rather than
  // in an effect, so the form never paints a stale value first.
  const [syncedConfig, setSyncedConfig] = useState(config);
  if (config !== syncedConfig) {
    setSyncedConfig(config);
    if (!isDirty(draft, syncedConfig)) setDraft(draftFromConfig(config));
  }

  const dirty = isDirty(draft, config);
  const built = buildInput(draft);
  const rateErrors = built.ok ? {} : built.rateErrors;
  const formError = built.ok ? null : built.formError;

  // A flow's error shows once its input has been left (then stays live), never
  // while a first value is still being typed — "0." on the way to "0.5" is not
  // a mistake. Save stays disabled for any invalid flow regardless.
  const [touched, setTouched] = useState<ReadonlySet<FeeOperationType>>(() => new Set());
  const touch = (op: FeeOperationType) => setTouched((t) => (t.has(op) ? t : new Set(t).add(op)));
  const resetTo = (next: NetworkFeeConfigResponse) => {
    setDraft(draftFromConfig(next));
    setTouched(new Set());
  };

  const saveMu = useMutation({
    mutationFn: (input: SetNetworkFeeConfigInput) =>
      apiFetch<NetworkFeeConfigResponse>(`/admin/companies/${companyId}/network-fee`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (saved) => {
      toast.success('Network fee saved');
      resetTo(saved);
      // Show the saved config at once (no "unsaved" flash while the refetch is
      // in flight), then refresh the whole company — its KPIs and audit log too.
      qc.setQueryData<CompanyDetailResponse>(['admin', 'company', companyId], (old) =>
        old ? { ...old, networkFee: saved } : old,
      );
      qc.invalidateQueries({ queryKey: ['admin', 'company', companyId] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });
  const saving = saveMu.isPending;

  const setRate = (op: FeeOperationType, patch: Partial<NetworkFeeRateDraft>) =>
    setDraft((d) => ({ ...d, rates: { ...d.rates, [op]: { ...d.rates[op], ...patch } } }));

  function save() {
    if (!built.ok) return;
    if (!window.confirm(confirmSaveMessage(companyName, built.value, config.enabled))) return;
    saveMu.mutate(built.value);
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Header — the master switch. Laid out like the visibility card above;
            the badge shows what is live, the switch what will be saved. */}
        <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Switch
              id="company-network-fee"
              aria-label="Charge a network fee"
              checked={draft.enabled}
              disabled={!canEdit || saving}
              onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />
            <div>
              <label htmlFor="company-network-fee" className="text-sm font-medium">
                Network fee
              </label>
              <p className="text-sm text-muted-foreground">
                A second platform fee charged alongside the commission, set per flow. It follows
                each flow&apos;s commission rule (deducted or on top) and is booked as platform
                revenue. Changes apply to new operations only.
              </p>
            </div>
          </div>
          <Badge variant={config.enabled ? 'success' : 'secondary'}>
            {config.enabled ? 'On' : 'Off'}
          </Badge>
        </div>

        {/* Per-flow rates */}
        <div className="space-y-2 border-t px-6 py-4">
          {!draft.enabled && (
            <p className="text-xs text-muted-foreground">
              Off — nothing is charged. Rates are kept for when you turn it back on.
            </p>
          )}
          <div className={cn('space-y-2 transition-opacity', !draft.enabled && 'opacity-60')}>
            {FEE_OPERATION_TYPES.map((op) =>
              canEdit ? (
                <RateRow
                  key={op}
                  op={op}
                  rate={draft.rates[op]}
                  error={touched.has(op) ? rateErrors[op] : undefined}
                  disabled={saving}
                  onChange={(patch) => setRate(op, patch)}
                  onTouched={() => touch(op)}
                />
              ) : (
                <ReadOnlyRateRow key={op} op={op} rate={draft.rates[op]} />
              ),
            )}
          </div>
          {/* Guidance, not an error: it appears the moment the switch is turned
              on, before any rate could have been typed. */}
          {canEdit && formError && <p className="text-xs text-muted-foreground">{formError}</p>}
        </div>

        {canEdit ? (
          <div className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Leave a flow blank to not charge it. Fixed fees are dollars (2 decimals); percentages
              up to 8 decimals, max 100.
            </p>
            <div className="flex shrink-0 items-center justify-end gap-2">
              {dirty && !saving && (
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => resetTo(config)}
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || !built.ok || saving}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save network fee'}
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t px-6 py-3 text-xs text-muted-foreground">
            Only a super admin can change the network fee.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** One editable flow: $/% toggle (as in the commission tier editor), value, live example. */
function RateRow({
  op,
  rate,
  error,
  disabled,
  onChange,
  onTouched,
}: {
  op: FeeOperationType;
  rate: NetworkFeeRateDraft;
  error: string | undefined;
  disabled: boolean;
  onChange: (patch: Partial<NetworkFeeRateDraft>) => void;
  // The flow was left or its $/% type changed: its error may show from now on.
  onTouched: () => void;
}) {
  const id = `network-fee-${op}`;
  const label = FEE_OPERATION_LABEL[op];
  const percent = rate.feeType === CommissionType.PERCENTAGE;
  const example = exampleOn100(rate);
  const describedBy = [error && `${id}-error`, example && `${id}-example`]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="grid grid-cols-[6rem_auto_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[7.5rem_auto_10rem_minmax(0,1fr)]">
        <label htmlFor={id} className="pl-1 text-sm font-medium">
          {label}
        </label>
        <div
          role="group"
          aria-label={`${label} fee type`}
          className="flex overflow-hidden rounded-md border"
        >
          <button
            type="button"
            aria-label="Fixed amount ($)"
            aria-pressed={!percent}
            disabled={disabled}
            className={`px-2.5 py-2 text-xs disabled:opacity-50 ${!percent ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
            onClick={() => {
              onChange({ feeType: CommissionType.FIXED });
              onTouched();
            }}
          >
            $
          </button>
          <button
            type="button"
            aria-label="Percentage (%)"
            aria-pressed={percent}
            disabled={disabled}
            className={`px-2.5 py-2 text-xs disabled:opacity-50 ${percent ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
            onClick={() => {
              onChange({ feeType: CommissionType.PERCENTAGE });
              onTouched();
            }}
          >
            %
          </button>
        </div>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Not charged"
          value={rate.feeValue}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(error && 'border-destructive focus-visible:ring-destructive')}
          onChange={(e) => onChange({ feeValue: e.target.value })}
          onBlur={onTouched}
        />
        {example && (
          <p
            id={`${id}-example`}
            className="col-span-3 pl-1 text-xs tabular-nums text-muted-foreground sm:col-span-1"
          >
            {example}
          </p>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1.5 pl-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** One flow for a viewer who can't edit: the rate as text, with the same example. */
function ReadOnlyRateRow({ op, rate }: { op: FeeOperationType; rate: NetworkFeeRateDraft }) {
  const value = rate.feeValue.trim();
  const example = exampleOn100(rate);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm">
      <span className="font-medium">{FEE_OPERATION_LABEL[op]}</span>
      <span className="flex items-baseline gap-3 text-right">
        {example && <span className="text-xs tabular-nums text-muted-foreground">{example}</span>}
        {value ? (
          <span className="font-medium tabular-nums">
            {formatNetworkFeeRate(rate.feeType, value)}
          </span>
        ) : (
          <span className="text-muted-foreground">Not charged</span>
        )}
      </span>
    </div>
  );
}
