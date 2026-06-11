'use client';
import dynamic from 'next/dynamic';

/**
 * Lazily-loaded VolumeChart. Recharts is ~150KB of JS; loading it on demand
 * keeps it off the route's initial bundle so pages paint and become responsive
 * sooner. The fallback matches the chart's height so layout doesn't shift when
 * it arrives. (No `ssr: false` — it trips a Next 15 /404 prerender bug, and it's
 * moot here: the chart only mounts once client-side query data exists, so it
 * never renders during SSR anyway.)
 */
export const VolumeChart = dynamic(() => import('./volume-chart').then((m) => m.VolumeChart), {
  loading: () => <div className="h-72 w-full animate-pulse rounded bg-muted" />,
});
