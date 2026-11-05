import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'success'; data: T } | { status: 'error'; error: unknown };

interface Settled<T> {
  load: unknown;
  version: number;
  state: AsyncState<T>;
}

/**
 * Runs `load` whenever it changes or `reload` is called, and cancels what is in flight. Wrap `load`
 * in `useCallback`, whose dependencies say when to fetch again. A result only counts for the request
 * that produced it, so a slow response can never overwrite a newer one.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>): {
  state: AsyncState<T>;
  reload: () => void;
  /** Replaces the data with what a mutation returned, without showing a loading state. */
  setData: (data: T) => void;
} {
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setSettled({ load, version, state: { status: 'success', data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ load, version, state: { status: 'error', error } });
      },
    );
    return () => controller.abort();
  }, [load, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const setData = useCallback(
    (data: T) => setSettled({ load, version, state: { status: 'success', data } }),
    [load, version],
  );

  const current = settled?.load === load && settled.version === version;
  return { state: current ? settled.state : { status: 'loading' }, reload, setData };
}
