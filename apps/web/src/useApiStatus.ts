import { useEffect, useState } from 'react';
import { fetchApiStatus, type ApiStatus } from './api';

const POLL_INTERVAL_MS = 15_000;

export function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
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
  }, []);

  return status;
}
