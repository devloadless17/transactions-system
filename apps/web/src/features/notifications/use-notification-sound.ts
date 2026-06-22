'use client';
import { useCallback, useEffect, useRef } from 'react';

export const NOTIF_MUTE_KEY = 'notif-sound-muted';

// Build a short, clearly-audible two-note chime as a 16-bit PCM WAV and hand
// back an object URL. We play it through an <audio> element (the standard media
// path) rather than Web Audio oscillators — more reliably audible across
// machines/browsers, and it still respects the OS volume. Built once, lazily.
let cachedUrl: string | null = null;
function chimeUrl(): string | null {
  if (cachedUrl) return cachedUrl;
  if (typeof window === 'undefined') return null;
  try {
    const sr = 44100;
    const dur = 0.55;
    const n = Math.floor(sr * dur);
    // G5 then C6 — a pleasant rising "ding-dong".
    const notes = [
      { f: 783.99, start: 0.0 },
      { f: 1046.5, start: 0.16 },
    ];
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ws = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    ws(36, 'data');
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let v = 0;
      for (const note of notes) {
        const r = t - note.start;
        if (r >= 0) {
          const env = Math.min(1, r / 0.005) * Math.exp(-r * 4); // 5ms attack, gentle decay
          v += Math.sin(2 * Math.PI * note.f * r) * env;
        }
      }
      v = Math.max(-1, Math.min(1, v * 0.7)); // loud, clamped
      dv.setInt16(44 + i * 2, v * 32767, true);
    }
    cachedUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    return cachedUrl;
  } catch {
    return null;
  }
}

/**
 * Returns `play()` — rings a notification chime via an <audio> element.
 * Browsers block audio until the user interacts, so we "unlock" the element on
 * the first pointer/key event (a muted play+pause). `play({ force: true })`
 * ignores the mute flag — used by the Test-sound button.
 */
export function useNotificationSound(): (opts?: { force?: boolean }) => void {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const get = useCallback((): HTMLAudioElement | null => {
    if (!audioRef.current) {
      const url = chimeUrl();
      if (url) {
        const a = new Audio(url);
        a.preload = 'auto';
        audioRef.current = a;
      }
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    const prime = () => {
      const a = get();
      if (!a) return;
      a.muted = true;
      a.play()
        .then(() => {
          a.pause();
          a.currentTime = 0;
          a.muted = false;
        })
        .catch(() => {
          a.muted = false;
        });
    };
    window.addEventListener('pointerdown', prime);
    window.addEventListener('keydown', prime);
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, [get]);

  return useCallback(
    (opts?: { force?: boolean }) => {
      try {
        if (!opts?.force && window.localStorage.getItem(NOTIF_MUTE_KEY) === '1') return;
        const a = get();
        if (!a) return;
        a.muted = false;
        a.volume = 1;
        a.currentTime = 0;
        void a.play().catch(() => {});
      } catch {
        /* never let a sound failure surface */
      }
    },
    [get],
  );
}
