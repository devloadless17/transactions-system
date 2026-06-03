'use client';
import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after it has stopped changing for
 * `delayMs`. Useful for feeding a fast-changing input (e.g. a search box) into
 * a React Query key without firing a request on every keystroke. The input
 * stays fully controlled by the caller — only the returned value lags.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
