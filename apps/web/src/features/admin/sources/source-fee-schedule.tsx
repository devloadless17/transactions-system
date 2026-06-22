'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import {
  CommissionType,
  Money,
  SourceFeeChannel,
  setSourceFeeRulesSchema,
  type SourceFeeRuleInput,
  type SourceFeeRuleResponse,
} from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { formatNumber as fmt } from '@/lib/format';

// A tier the admin edits, per channel. `max` is the inclusive upper bound — the
// largest amount that still pays this tier ("up to and including $max"). An empty
// `max` means the open-ended top tier ("everything above the previous tier"); it
// must be the last tier. The lower bound is implicit: the previous tier's max.
interface TierForm {
  max: string; // '' = open-ended (and above)
  feeType: CommissionType;
  feeValue: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;

const CHANNEL_META: Record<SourceFeeChannel, { title: string; blurb: string }> = {
  INGEST: {
    title: 'Ingestion',
    blurb: 'Deposits ingested directly through the API.',
  },
  WHISH_PAY: {
    title: 'Whish Pay',
    blurb: 'Deposits settled from a Whish collect link the company generated.',
  },
};

function emptyTier(): TierForm {
  return { max: '', feeType: CommissionType.FIXED, feeValue: '' };
}

/** Rebuild the per-channel form ladder from the stored [min,max] rules. */
function rulesToForm(rules: SourceFeeRuleResponse[], channel: SourceFeeChannel): TierForm[] {
  const forChannel = rules
    .filter((r) => r.channel === channel)
    .sort((a, b) => Money.of(a.minAmount).cmp(Money.of(b.minAmount)));
  if (forChannel.length === 0) return [emptyTier()];
  return forChannel.map((r) => ({
    max: r.maxAmount === null ? '' : r.maxAmount,
    feeType: r.feeType,
    feeValue: r.feeValue,
  }));
}

/**
 * Per-source fee schedule editor — what THIS source charges the platform per
 * deposit (the platform's cost of funds, used for net-revenue reporting).
 * System/admin-only; companies never see any of this.
 */
export function SourceFeeSchedule({
  sourceId,
  sourceCode,
  onSaved,
}: {
  sourceId: string;
  sourceCode: string;
  onSaved?: () => void;
}) {
  // Whish is the only source with a collect-link product, so only it shows the
  // WHISH_PAY channel; every source has the direct-ingest channel.
  const channels: SourceFeeChannel[] =
    sourceCode === 'whish'
      ? [SourceFeeChannel.INGEST, SourceFeeChannel.WHISH_PAY]
      : [SourceFeeChannel.INGEST];

  const [byChannel, setByChannel] = useState<Record<string, TierForm[]>>({});
  const [submitting, setSubmitting] = useState(false);

  const rulesQ = useQuery({
    queryKey: ['admin', 'source', sourceId, 'fee-rules'],
    queryFn: () =>
      apiFetch<{ data: SourceFeeRuleResponse[] }>(`/admin/sources/${sourceId}/fee-rules`),
  });

  useEffect(() => {
    if (!rulesQ.data) return;
    const next: Record<string, TierForm[]> = {};
    for (const ch of channels) next[ch] = rulesToForm(rulesQ.data.data, ch);
    setByChannel(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesQ.data, sourceCode]);

  function setTier(channel: string, i: number, patch: Partial<TierForm>) {
    setByChannel((prev) => ({
      ...prev,
      [channel]: (prev[channel] ?? []).map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
    }));
  }
  function addTier(channel: string) {
    setByChannel((prev) => {
      const list = prev[channel] ?? [];
      // New band goes before the open-ended top: give the previous last tier a
      // concrete max so the new one becomes the "and above" tier.
      return { ...prev, [channel]: [...list, emptyTier()] };
    });
  }
  function removeTier(channel: string, i: number) {
    setByChannel((prev) => {
      const list = prev[channel] ?? [];
      if (list.length <= 1) return prev;
      return { ...prev, [channel]: list.filter((_, idx) => idx !== i) };
    });
  }

  function buildRules(): SourceFeeRuleInput[] | null {
    const rules: SourceFeeRuleInput[] = [];
    for (const ch of channels) {
      const tiers = byChannel[ch] ?? [];
      // Sort so the open-ended (empty max) tier is last; concrete maxes ascend.
      const sorted = [...tiers].sort((a, b) => {
        if (a.max === '' && b.max === '') return 0;
        if (a.max === '') return 1;
        if (b.max === '') return -1;
        return Money.of(a.max).cmp(Money.of(b.max));
      });
      let prevMax = '0';
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i]!;
        const isLast = i === sorted.length - 1;
        if (!DECIMAL.test(t.feeValue.trim())) {
          toast.error(`${CHANNEL_META[ch].title}: every tier needs a fee value.`);
          return null;
        }
        if (!isLast && !DECIMAL.test(t.max.trim())) {
          toast.error(
            `${CHANNEL_META[ch].title}: every tier except the last needs an "up to" amount.`,
          );
          return null;
        }
        if (t.max !== '' && !isLast && Money.of(t.max).lte(Money.of(prevMax)) && prevMax !== '0') {
          toast.error(`${CHANNEL_META[ch].title}: tier amounts must increase.`);
          return null;
        }
        rules.push({
          channel: ch,
          minAmount: prevMax,
          maxAmount: isLast ? null : t.max.trim(),
          feeType: t.feeType,
          feeValue: t.feeValue.trim(),
          active: true,
        });
        prevMax = isLast ? prevMax : t.max.trim();
      }
    }
    return rules;
  }

  async function save() {
    const rules = buildRules();
    if (!rules) return;
    const parsed = setSourceFeeRulesSchema.safeParse({ rules });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Please check the schedule');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/admin/sources/${sourceId}/fee-rules`, { method: 'PUT', body: parsed.data });
      toast.success('Fee schedule saved');
      rulesQ.refetch();
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Source fee schedule</CardTitle>
        <CardDescription>
          What this source charges <span className="font-medium">the platform</span> on each deposit
          — the platform&apos;s cost of funds, used to compute net revenue. This is internal:
          companies never see it. Each tier is{' '}
          <span className="font-medium">inclusive of its “up to” amount</span>; the next tier covers
          everything above it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rulesQ.isLoading ? (
          <div className="h-24 w-full animate-pulse rounded bg-muted" />
        ) : (
          channels.map((ch) => (
            <div key={ch} className="space-y-2">
              <div>
                <p className="text-sm font-medium">{CHANNEL_META[ch].title}</p>
                <p className="text-xs text-muted-foreground">{CHANNEL_META[ch].blurb}</p>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span>Up to &amp; incl. ($)</span>
                <span className="text-center">Fee</span>
                <span />
                <span />
              </div>
              {(byChannel[ch] ?? []).map((t, i) => {
                const list = byChannel[ch] ?? [];
                const isLast = i === list.length - 1;
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 rounded-md border bg-muted/20 p-2"
                  >
                    <Input
                      inputMode="decimal"
                      placeholder={isLast ? 'and above' : '10'}
                      value={t.max}
                      disabled={isLast}
                      title={
                        isLast
                          ? 'The last tier covers every amount above the tier before it'
                          : undefined
                      }
                      onChange={(e) => setTier(ch, i, { max: e.target.value })}
                    />
                    <div className="flex overflow-hidden rounded-md border">
                      <button
                        type="button"
                        className={`px-2.5 py-2 text-xs ${t.feeType === CommissionType.FIXED ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                        onClick={() => setTier(ch, i, { feeType: CommissionType.FIXED })}
                      >
                        $
                      </button>
                      <button
                        type="button"
                        className={`px-2.5 py-2 text-xs ${t.feeType === CommissionType.PERCENTAGE ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                        onClick={() => setTier(ch, i, { feeType: CommissionType.PERCENTAGE })}
                      >
                        %
                      </button>
                    </div>
                    <Input
                      inputMode="decimal"
                      placeholder={t.feeType === CommissionType.PERCENTAGE ? '1' : '1.00'}
                      value={t.feeValue}
                      onChange={(e) => setTier(ch, i, { feeValue: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove tier"
                      disabled={list.length === 1}
                      onClick={() => removeTier(ch, i)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm" onClick={() => addTier(ch)}>
                <Plus className="mr-1 h-4 w-4" /> Add tier
              </Button>
              <ChannelPreview tiers={byChannel[ch] ?? []} />
            </div>
          ))
        )}
        <div className="flex justify-end">
          <Button type="button" disabled={submitting || rulesQ.isLoading} onClick={save}>
            {submitting ? 'Saving…' : 'Save fee schedule'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Plain-language "this is what it means" preview, with unambiguous boundaries. */
function ChannelPreview({ tiers }: { tiers: TierForm[] }) {
  const sorted = [...tiers].sort((a, b) => {
    if (a.max === '' && b.max === '') return 0;
    if (a.max === '') return 1;
    if (b.max === '') return -1;
    return Money.of(a.max).cmp(Money.of(b.max));
  });
  let prev = '0';
  const lines = sorted.map((t, i) => {
    const isLast = i === sorted.length - 1;
    const feeOk = DECIMAL.test(t.feeValue.trim());
    const fee = feeOk
      ? t.feeType === CommissionType.PERCENTAGE
        ? `${fmt(t.feeValue)}%`
        : `$${fmt(t.feeValue)} flat`
      : '—';
    let range: string;
    if (isLast) {
      range = Number(prev) === 0 ? 'Any amount' : `Above $${fmt(prev)}`;
    } else if (!DECIMAL.test(t.max.trim())) {
      range = '…';
    } else if (Number(prev) === 0) {
      range = `Up to & incl. $${fmt(t.max)}`;
    } else {
      range = `$${fmt(prev)}.01 – $${fmt(t.max)}`;
    }
    if (!isLast && DECIMAL.test(t.max.trim())) prev = t.max.trim();
    return { range, fee };
  });
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-1.5 font-medium text-muted-foreground">Preview</p>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="flex items-center gap-2 text-muted-foreground">
            <span className="tabular-nums">{l.range}</span>
            <ArrowRight className="h-3 w-3 shrink-0" />
            <span className="font-medium text-foreground">{l.fee}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
