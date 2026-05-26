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
import type { DailyBucket } from '@app/shared';

export function VolumeChart({ buckets, currency }: { buckets: DailyBucket[]; currency: string }) {
  const data = buckets.map((b) => ({
    date: b.date.slice(5), // MM-DD
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
          <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
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
          />
          <Area
            type="monotone"
            dataKey="volume"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            fill="url(#volumeFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
