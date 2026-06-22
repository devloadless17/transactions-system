'use client';
import { useEffect, useRef, useState } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';

/**
 * A thin, GitHub/NProgress-style loading line pinned to the very top of the
 * viewport. It is driven by real TanStack Query activity (any query fetching or
 * mutation in flight), so it appears exactly when there is genuine network work
 * and stays invisible when data is served from cache — which is already instant.
 *
 * Perceived-speed feedback only; per-view skeletons remain the accessible
 * loading state (hence `aria-hidden`). Animates `transform`/`opacity` exclusively
 * so it is fully compositor-driven and never triggers layout/jank.
 *
 * Mount once, inside the QueryClientProvider.
 */

// A short delay before the bar appears: cached / sub-120ms loads never flash it,
// so the bar reads as "real work is happening" rather than visual noise.
const START_DELAY = 120;
// Cadence of the trickle toward the 92% ceiling while we wait for the response.
const TRICKLE_MS = 280;
// Matches the `duration-300` opacity fade on the wrapper below.
const FADE_MS = 300;
// Keep the bar on screen at least this long once shown, so completion reads as a
// deliberate fill rather than a flicker on a fast-but-not-instant load.
const MIN_VISIBLE_MS = 300;

export function TopProgressBar() {
  // Only count loads the user is actually *waiting on*:
  //   • `data === undefined` → an initial / new-query-key fetch (nothing to show
  //     yet). Background refetches (revalidation, refetchInterval, refetch on a
  //     cached page) already have data on screen, so they must not flash the bar.
  //   • `meta.background` → ambient widgets (sidebar pending-counts, the
  //     notification bell) that mount with the persistent layout. Excluding them
  //     stops the "bar runs twice on refresh" (layout-fetch wave + page-fetch wave)
  //     and the periodic flashes from their polling.
  // Mutations are always user-initiated, so they keep driving the bar.
  const fetching = useIsFetching({
    predicate: (q) => q.state.data === undefined && !q.meta?.background,
  });
  const active = fetching + useIsMutating() > 0;

  const [progress, setProgress] = useState(0); // 0..1, the scaleX of the bar
  const [visible, setVisible] = useState(false);

  const timers = useRef<{
    start?: ReturnType<typeof setTimeout>;
    trickle?: ReturnType<typeof setInterval>;
    done?: ReturnType<typeof setTimeout>;
    reset?: ReturnType<typeof setTimeout>;
    shownAt: number;
  }>({ shownAt: 0 });

  useEffect(() => {
    const t = timers.current;

    const startTrickle = () => {
      if (t.trickle) return;
      t.trickle = setInterval(() => {
        // Ease-out: smaller steps as we approach the cap, so it never reaches 100%
        // until the work actually finishes.
        setProgress((p) =>
          p >= 0.92 ? p : p + Math.min((0.92 - p) * 0.16, 0.04 + Math.random() * 0.03),
        );
      }, TRICKLE_MS);
    };
    const stopTrickle = () => {
      if (t.trickle) {
        clearInterval(t.trickle);
        t.trickle = undefined;
      }
    };

    if (active) {
      // There's work again — cancel any in-flight finish/reset.
      if (t.done) {
        clearTimeout(t.done);
        t.done = undefined;
      }
      if (t.reset) {
        clearTimeout(t.reset);
        t.reset = undefined;
      }

      if (visible) {
        // A new wave started as the previous one was completing — pull back from
        // the 100% fill (if any) and keep trickling instead of leaving a stuck bar.
        setProgress((p) => (p > 0.9 ? 0.5 : p));
        startTrickle();
        return;
      }
      // Debounce the first appearance.
      if (t.start) return;
      t.start = setTimeout(() => {
        t.start = undefined;
        t.shownAt = Date.now();
        setVisible(true);
        setProgress(0.08);
        startTrickle();
      }, START_DELAY);
    } else {
      // The load resolved before the bar was even shown — drop the pending start.
      if (t.start) {
        clearTimeout(t.start);
        t.start = undefined;
      }
      if (!visible) return;
      // Finish: snap to 100%, hold briefly (respecting the minimum on-screen time),
      // fade out, then reset so the next run starts cleanly from the left.
      stopTrickle();
      setProgress(1);
      const elapsed = Date.now() - t.shownAt;
      const hold = Math.max(160, MIN_VISIBLE_MS - elapsed);
      t.done = setTimeout(() => {
        t.done = undefined;
        setVisible(false);
        t.reset = setTimeout(() => {
          t.reset = undefined;
          setProgress(0);
        }, FADE_MS);
      }, hold);
    }
    // Driven purely by `active`; `visible`/`progress` are read from the latest
    // committed closure (React reruns this only when `active` flips).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Tear down every timer on unmount.
  useEffect(() => {
    const t = timers.current;
    return () => {
      if (t.start) clearTimeout(t.start);
      if (t.trickle) clearInterval(t.trickle);
      if (t.done) clearTimeout(t.done);
      if (t.reset) clearTimeout(t.reset);
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px] transition-opacity duration-300 ease-out motion-reduce:transition-none"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div
        className="h-full w-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          transform: `scaleX(${progress})`,
          // A soft leading-edge glow in the brand color — the NProgress "peg".
          boxShadow: '0 0 10px hsl(var(--primary) / 0.45), 0 1px 4px hsl(var(--primary) / 0.4)',
        }}
      />
    </div>
  );
}
