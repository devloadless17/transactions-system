/**
 * Pure helpers for the error boundaries (app/error.tsx, app/pay/error.tsx); the
 * React side lives in use-error-recovery.ts.
 */

// The ways a browser reports that a lazily loaded script or stylesheet could not
// be fetched. After a deploy the old build's files are gone, so a tab opened
// before it fails the first time it needs a chunk it hadn't loaded yet (a chart,
// the date picker, the realtime client). Only a full page load fixes that.
const CHUNK_LOAD_FAILURE = [
  /Loading (CSS )?chunk [\w-]+ failed/i, //           webpack (next build)
  /Failed to fetch dynamically imported module/i, //   Chrome, native import()
  /error loading dynamically imported module/i, //     Firefox
  /Importing a module script failed/i, //              Safari
];

/** True when `error` means the page's own code could not be downloaded. */
export function isChunkLoadError(error: { name?: string; message?: string }): boolean {
  if (error.name === 'ChunkLoadError') return true;
  const message = error.message ?? '';
  return CHUNK_LOAD_FAILURE.some((re) => re.test(message));
}

/**
 * At most one automatic reload per this window: if a reload did not fix it (the
 * file is really missing, not just from an older build), stop and show the error
 * instead of reloading forever.
 */
export const CHUNK_RELOAD_COOLDOWN_MS = 30_000;

/** Whether to reload now, given when we last did (0 = never). */
export function shouldAutoReload(lastReloadAt: number, now: number): boolean {
  return !(lastReloadAt > 0 && now - lastReloadAt < CHUNK_RELOAD_COOLDOWN_MS);
}

/**
 * One line that identifies a failure when someone reports it. A server-side
 * failure arrives with its message stripped (production builds) but carries a
 * digest that is also in the web server's log next to the real error, so the
 * digest is the reference. A browser-side failure has no digest; its own name
 * and message are what there is — the same text the console already shows.
 */
export function errorReference(error: { name?: string; message?: string; digest?: string }): {
  label: string;
  value: string;
} {
  if (error.digest) return { label: 'Reference', value: error.digest };
  const text = `${error.name ?? 'Error'}: ${error.message ?? ''}`.trim();
  return { label: 'Details', value: text.length > 200 ? `${text.slice(0, 199)}…` : text };
}
