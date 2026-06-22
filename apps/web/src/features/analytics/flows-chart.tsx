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
import type { FlowsBucket } from '@app/shared';

/**
 * Daily money-in (deposits + loads) vs money-out (withdrawals + payouts) flows
 * for a currency, with fees overlaid as a line. "In" and "out" are stacked
 * areas so the operator can see net flow at a glance.
 */
export function FlowsChart({ buckets, currency }: { buckets: FlowsBucket[]; currency: string }) {
  const data = buckets.map((b) => ({
    date: b.date.slice(5), // MM-DD
    in: Number(b.in),
    out: -Number(b.out), // negative so it draws below the axis
    fees: Number(b.fees),
  }));

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
          <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
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
                  : 'Fees',
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value: string) =>
              value === 'in'
                ? 'In (deposits + loads)'
                : value === 'out'
                  ? 'Out (withdrawals + payouts)'
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
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
