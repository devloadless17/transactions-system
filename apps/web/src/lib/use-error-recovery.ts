'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useTransition } from 'react';
import { isChunkLoadError, shouldAutoReload } from './error-recovery';

const RELOAD_AT_KEY = 'txn:chunk-reload-at';

/**
 * Recovery for an error boundary, so "Try again" does what a refresh would.
 *
 * - A server-rendered failure (e.g. the API was briefly unreachable): `reset()`
 *   alone re-renders the SAME failed server payload, so the button did nothing
 *   and only a browser refresh helped. `retry` re-requests the page from the
 *   server first (router.refresh) and then resets, in one transition.
 * - A tab left open across a deploy that can't download a chunk: nothing short
 *   of a full page load fixes it, so the page reloads itself once, straight
 *   away; `retry` reloads too.
 */
export function useErrorRecovery(
  error: Error,
  reset: () => void,
): { retry: () => void; retrying: boolean } {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();
  const staleBuild = isChunkLoadError(error);

  useEffect(() => {
    if (!staleBuild) return;
    // Without storage there is no loop guard — leave it to the button.
    try {
      const last = Number(sessionStorage.getItem(RELOAD_AT_KEY)) || 0;
      if (!shouldAutoReload(last, Date.now())) return;
      sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  }, [staleBuild]);

  const retry = useCallback(() => {
    if (staleBuild) {
      window.location.reload();
      return;
    }
    startTransition(() => {
      router.refresh();
      reset();
    });
  }, [staleBuild, router, reset]);

  return { retry, retrying };
}
