'use client';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BucketGranularity, DailyBucket } from '@app/shared';
import { formatBucketTick, formatBucketTooltip } from '@/lib/date-presets';

export function VolumeChart({
  buckets,
  currency,
  granularity = 'day',
}: {
  buckets: DailyBucket[];
  currency: string;
  /** Bucket width the server chose; labels must follow it or a month reads as a day. */
  granularity?: BucketGranularity;
}) {
  const data = buckets.map((b) => ({
    date: formatBucketTick(b.date, granularity),
    bucketStart: b.date,
    volume: Number(b.volume),
    fees: Number(b.fees),
    count: b.count,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="volumeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
              <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
            // Month buckets over a long history would otherwise overprint.
            minTickGap={24}
          />
          <YAxis tick={{ fontSize: 11 }} width={50} />
          <Tooltip
            cursor={{ fill: 'hsl(var(--accent) / 0.3)' }}
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [
              `${value.toLocaleString()} ${currency}`,
              name === 'volume' ? 'Volume' : name === 'fees' ? 'Fees' : name,
            ]}
            // Without this the header is the bare tick, so a week/month bucket
            // gives no clue how much time it covers.
            labelFormatter={(
              _label: string,
              payload: ReadonlyArray<{ payload?: { bucketStart?: string } }>,
            ) => {
              const start = payload?.[0]?.payload?.bucketStart;
              return start ? formatBucketTooltip(start, granularity) : _label;
            }}
          />
          <Area
            type="monotone"
            dataKey="volume"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            fill="url(#volumeFill)"
            // A single bucket (a brand-new company on All time) draws no line
            // at all without a visible point.
            dot={data.length === 1}
            // No draw animation: live realtime refreshes re-render the chart, and
            // the ~1.5s path-morph on every refresh reads as jank, not polish.
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
