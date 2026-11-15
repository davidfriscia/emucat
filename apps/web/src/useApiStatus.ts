import { useEffect, useState } from 'react';
import { fetchApiStatus, type ApiStatus } from './api';
import { usePageVisible } from './usePolledData';

const POLL_INTERVAL_MS = 15_000;

/** Whether the API answers. Checked every 15 seconds while the tab shows, and at once when it shows again. */
export function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>('checking');
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const check = async () => {
      const next = await fetchApiStatus(controller.signal);
      if (!controller.signal.aborted) setStatus(next);
    };
    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [visible]);

  return status;
}
