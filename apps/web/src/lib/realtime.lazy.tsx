'use client';
import dynamic from 'next/dynamic';

/**
 * Lazily-loaded {@link RealtimeBridge}. socket.io-client is ~13KB gzipped and is
 * only needed post-mount (the bridge renders null and opens the socket in a
 * useEffect), so loading it on demand keeps it — and socket.io — off every
 * authenticated route's initial JS. No `ssr: false`: it trips a Next 15 /404
 * prerender bug (see volume-chart.lazy.tsx) and is moot here since the bridge
 * renders null on the server regardless. No loading fallback: nothing to show.
 */
export const RealtimeBridge = dynamic(() => import('./realtime').then((m) => m.RealtimeBridge));
