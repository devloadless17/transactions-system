'use client';
import { useEffect } from 'react';
import { lastRefreshAt, markRefreshed, refreshSession } from './api.client';

// The access cookie lives 15 min (JWT_ACCESS_TTL). Rotate well before that so
// it never lapses while a tab is open — which also keeps the realtime socket
// reconnectable after a page refresh.
const REFRESH_AFTER_MS = 13 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;

/**
 * Keeps the session alive while an authenticated tab is open by rotating the
 * access cookie before it expires. Coordinated across tabs via a shared
 * localStorage timestamp (the refresh endpoint revokes the old refresh token,
 * so only the tab that crosses the threshold first actually refreshes).
 *
 * Render once inside an authenticated layout.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    // Seed the shared clock on first run so we don't refresh a just-issued
    // cookie. Persisted across reloads, so a hard refresh doesn't reset it.
    if (!lastRefreshAt()) markRefreshed();

    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastRefreshAt() >= REFRESH_AFTER_MS) void refreshSession();
    }, CHECK_EVERY_MS);

    return () => clearInterval(id);
  }, []);

  return null;
}
