import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export interface PolledData<T> {
  /** The newest data received. It stays when a later request fails, so a page does not go blank. */
  data: T | null;
  /** Why the latest request failed, or `null` if it succeeded. */
  error: unknown;
  /** True until the first request finishes. */
  loading: boolean;
  /** Requests again now, and restarts the wait for the next one. */
  refresh: () => void;
  /** Replaces the data with what a mutation returned. */
  setData: (data: T) => void;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const pageVisible = () => document.visibilityState !== 'hidden';

/** Whether the browser tab is showing the page. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
}

/**
 * Keeps a page up to date while it is open. Requests never overlap, a slow response can never
 * overwrite a newer one, and a failed request simply tries again at the next interval, which is how a
 * page recovers by itself when the server comes back. Pass `null` as the interval to request once.
 *
 * A new `load` or a `refresh()` requests at once. A change of interval only reschedules: the next
 * request is due one new interval after the last one, so switching between a fast and a slow pace
 * never adds a request of its own. Nothing is requested while the tab is hidden, and what fell due
 * meanwhile is requested as soon as it shows again.
 */
export function usePolledData<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
): PolledData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const visible = usePageVisible();
  // When the last request for this `load` and this `version` finished.
  const last = useRef<{ load: unknown; version: number; at: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const next = await load(controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure);
      }
      last.current = { load, version, at: Date.now() };
      setLoading(false);
      schedule(intervalMs);
    };
    const schedule = (wait: number | null) => {
      if (wait === null || !visible) return;
      timer = setTimeout(() => void run(), Math.max(0, wait));
    };

    const previous = last.current;
    if (previous?.load !== load || previous.version !== version) void run();
    else if (intervalMs !== null) schedule(previous.at + intervalMs - Date.now());

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [load, version, intervalMs, visible]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  return { data, error, loading, refresh, setData };
}
