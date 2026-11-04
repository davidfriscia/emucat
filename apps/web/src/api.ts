import {
  API_PREFIX,
  infoResponseSchema,
  readyResponseSchema,
  type InfoResponse,
} from '@emucat/contracts';

/**
 * `online`: the API and database are ready.
 * `degraded`: the API answers but is not ready, for example because the database is down.
 * `offline`: the API cannot be reached.
 */
export type ApiStatus = 'checking' | 'online' | 'degraded' | 'offline';

export async function fetchApiStatus(signal?: AbortSignal): Promise<ApiStatus> {
  try {
    const response = await fetch(`${API_PREFIX}/ready`, { signal: signal ?? null });
    // A failing dev proxy also answers 5xx, so the body has to be a real readiness report.
    const report = readyResponseSchema.safeParse(await response.json());
    if (!report.success) return 'offline';
    return report.data.status === 'ready' ? 'online' : 'degraded';
  } catch {
    return 'offline';
  }
}

export async function fetchApiInfo(signal?: AbortSignal): Promise<InfoResponse | null> {
  try {
    const response = await fetch(`${API_PREFIX}/info`, { signal: signal ?? null });
    const info = infoResponseSchema.safeParse(await response.json());
    return info.success ? info.data : null;
  } catch {
    return null;
  }
}
