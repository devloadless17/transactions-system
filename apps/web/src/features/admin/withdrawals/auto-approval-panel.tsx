'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateWithdrawalAutoApprovalInput, WithdrawalAutoApprovalConfig } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { toast } from '@/lib/toast';

const QKEY = ['admin', 'withdrawals', 'auto-approval'] as const;

/**
 * SUPER_ADMIN control for auto-approving Whish (WISH) withdrawals: the master
 * on/off switch, the hold window + max-amount policy, and the circuit-breaker
 * status (auto-pauses on Whish failure). OFF ⇒ everything is handled manually.
 */
export function AutoApprovalPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: QKEY,
    queryFn: () => apiFetch<WithdrawalAutoApprovalConfig>('/admin/withdrawals/auto-approval'),
  });

  const [hold, setHold] = useState('');
  const [max, setMax] = useState('');

  // Keep the editable fields in sync when the server config (re)loads.
  useEffect(() => {
    if (q.data) {
      setHold(String(q.data.holdSeconds));
      setMax(q.data.maxAutoApproveAmount);
    }
  }, [q.data]);

  const mu = useMutation({
    mutationFn: (body: UpdateWithdrawalAutoApprovalInput) =>
      apiFetch<WithdrawalAutoApprovalConfig>('/admin/withdrawals/auto-approval', {
        method: 'PUT',
        body,
      }),
    onSuccess: (data) => {
      qc.setQueryData(QKEY, data);
      qc.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
    },
    onError: (e) => toast.error(e instanceof ApiClientError ? e.message : 'Update failed'),
  });

  const cfg = q.data;
  const tripped = !!cfg?.circuitBreakerTrippedAt;
  const settingsDirty =
    !!cfg && (hold !== String(cfg.holdSeconds) || max !== cfg.maxAutoApproveAmount);

  const toggle = (enabled: boolean) => {
    mu.mutate(
      { enabled },
      { onSuccess: () => toast.success(enabled ? 'Auto-approval ON' : 'Auto-approval OFF') },
    );
  };

  const saveSettings = () => {
    const holdSeconds = Number(hold);
    if (!Number.isInteger(holdSeconds) || holdSeconds < 0)
      return toast.error('Hold seconds must be ≥ 0');
    if (!/^\d+(\.\d+)?$/.test(max.trim()) || Number(max) <= 0)
      return toast.error('Max amount must be a positive number');
    mu.mutate(
      { holdSeconds, maxAutoApproveAmount: max.trim() },
      { onSuccess: () => toast.success('Settings saved') },
    );
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Auto-approval (Whish)</h2>
              {cfg && (
                <Badge variant={cfg.enabled && !tripped ? 'success' : 'secondary'}>
                  {!cfg.enabled ? 'Off' : tripped ? 'Paused' : 'On'}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-prose text-xs text-muted-foreground">
              When ON, new <strong>Whish</strong> withdrawal requests are transferred and approved
              automatically — real money moves. Off ⇒ every request is handled manually in the queue
              below. Only requests created after enabling are auto-processed.
            </p>
          </div>
          <Switch
            checked={!!cfg?.enabled}
            disabled={q.isLoading || mu.isPending}
            onCheckedChange={toggle}
            aria-label="Toggle auto-approval"
          />
        </div>

        {tripped && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="font-medium">Auto-approval is paused by the circuit breaker.</p>
            <p className="mt-1">
              The Whish transfer side reported a problem (often an expired session). Withdrawals are
              waiting in the manual queue. Fix the session on the{' '}
              <Link href="/admin/transfer-money" className="underline">
                Transfer Money
              </Link>{' '}
              page — it auto-resumes once refreshed, or clear it manually.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={mu.isPending}
              onClick={() =>
                mu.mutate(
                  { clearBreaker: true },
                  { onSuccess: () => toast.success('Circuit breaker cleared') },
                )
              }
            >
              Clear &amp; resume
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="aa-hold" className="text-xs">
              Hold window (seconds)
            </Label>
            <Input
              id="aa-hold"
              className="h-8 w-32"
              inputMode="numeric"
              value={hold}
              onChange={(e) => setHold(e.target.value)}
              disabled={q.isLoading}
            />
            <p className="text-[11px] text-muted-foreground">
              Cancel window before auto-processing.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="aa-max" className="text-xs">
              Max auto amount (USD)
            </Label>
            <Input
              id="aa-max"
              className="h-8 w-32"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              disabled={q.isLoading}
            />
            <p className="text-[11px] text-muted-foreground">Above this → manual review.</p>
          </div>
          <Button size="sm" onClick={saveSettings} disabled={!settingsDirty || mu.isPending}>
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
