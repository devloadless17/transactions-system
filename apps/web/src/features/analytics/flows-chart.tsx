'use client';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BucketGranularity, FlowsBucket } from '@app/shared';
import { formatBucketTick, formatBucketTooltip } from '@/lib/date-presets';
import { isNonZeroAmount } from '@/lib/format';

// The optional network-fee line. Blue: clear of the green/red areas and of the
// primary-ink fees line in both themes (≥ 3:1 on either surface), and dashed so
// it also reads apart from the fees line without colour.
const NETWORK_FEE_STROKE = 'hsl(213 68% 50%)';

/**
 * Money-in (deposits + loads) vs money-out (withdrawals + payouts) flows for a
 * currency, with fees overlaid as a line. "In" and "out" are stacked areas so
 * the operator can see net flow at a glance. One point per bucket, whose width
 * the server picks from the window (day / week / month). Network fees get their
 * own dashed line, drawn only once any bucket in the window has earned one.
 */
export function FlowsChart({
  buckets,
  currency,
  granularity = 'day',
}: {
  buckets: FlowsBucket[];
  currency: string;
  granularity?: BucketGranularity;
}) {
  const data = buckets.map((b) => ({
    date: formatBucketTick(b.date, granularity),
    bucketStart: b.date,
    in: Number(b.in),
    out: -Number(b.out), // negative so it draws below the axis
    fees: Number(b.fees),
    networkFees: Number(b.networkFees),
  }));
  // Non-zero, not positive: a bucket's network-fee revenue is negative on a day
  // an earlier deposit is reversed, and the line must still be drawn then.
  const showNetworkFees = buckets.some((b) => isNonZeroAmount(b.networkFees));

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="inFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(142 71% 45%)" stopOpacity={0.45} />
              <stop offset="95%" stopColor="hsl(142 71% 45%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="outFill" x1="0" y1="1" x2="0" y2="0">
              <stop offset="5%" stopColor="hsl(0 84% 60%)" stopOpacity={0.45} />
              <stop offset="95%" stopColor="hsl(0 84% 60%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            width={60}
            tickFormatter={(v: number) => Math.abs(v).toLocaleString()}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [
              `${Math.abs(value).toLocaleString()} ${currency}`,
              name === 'in'
                ? 'In (deposits + loads)'
                : name === 'out'
                  ? 'Out (withdrawals + payouts)'
                  : name === 'networkFees'
                    ? 'Network fees'
                    : 'Fees',
            ]}
            labelFormatter={(
              _label: string,
              payload: ReadonlyArray<{ payload?: { bucketStart?: string } }>,
            ) => {
              const start = payload?.[0]?.payload?.bucketStart;
              return start ? formatBucketTooltip(start, granularity) : _label;
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value: string) =>
              value === 'in'
                ? 'In (deposits + loads)'
                : value === 'out'
                  ? 'Out (withdrawals + payouts)'
                  : value === 'networkFees'
                    ? 'Network fees'
                    : 'Fees earned'
            }
          />
          {/* No draw animation on any series: the chart re-renders on every live
              realtime refresh, and the triple path-morph reads as jank. */}
          <Area
            type="monotone"
            dataKey="in"
            stroke="hsl(142 71% 45%)"
            strokeWidth={2}
            fill="url(#inFill)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="out"
            stroke="hsl(0 84% 60%)"
            strokeWidth={2}
            fill="url(#outFill)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="fees"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {showNetworkFees && (
            <Line
              type="monotone"
              dataKey="networkFees"
              stroke={NETWORK_FEE_STROKE}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
