'use client';
import dynamic from 'next/dynamic';

/**
 * Lazily-loaded FlowsChart. See volume-chart.lazy.tsx — recharts loads on
 * demand so it stays off the route's initial bundle. Fallback height matches
 * the chart (h-80) to avoid layout shift when it mounts.
 */
export const FlowsChart = dynamic(() => import('./flows-chart').then((m) => m.FlowsChart), {
  loading: () => <div className="h-80 w-full animate-pulse rounded bg-muted" />,
});
