import { useCallback, useEffect, useState } from 'react';

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

/**
 * Keeps a page up to date while it is open. Requests never overlap, a slow response can never
 * overwrite a newer one, and a failed request simply tries again at the next interval, which is how a
 * page recovers by itself when the server comes back. Pass `null` as the interval to request once.
 */
export function usePolledData<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
): PolledData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

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
      setLoading(false);
      if (intervalMs !== null) timer = setTimeout(() => void run(), intervalMs);
    };
    void run();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [load, version, intervalMs]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  return { data, error, loading, refresh, setData };
}
