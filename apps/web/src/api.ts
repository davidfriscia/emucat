import {
  adminCatalogResponseSchema,
  adminMediaListResponseSchema,
  adminSummaryResponseSchema,
  adminVmApiPath,
  adminVmDetailSchema,
  agentListResponseSchema,
  agentSummarySchema,
  API_PREFIX,
  authenticatedSessionSchema,
  CSRF_HEADER,
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  infoResponseSchema,
  pairingRequestListResponseSchema,
  pairingRequestReviewSchema,
  publicCatalogResponseSchema,
  publicVmApiPath,
  publicVmDetailSchema,
  readyResponseSchema,
  revokedSessionsResponseSchema,
  sessionListResponseSchema,
  sessionStateResponseSchema,
  setupStatusResponseSchema,
  type AdminCatalogResponse,
  type AdminMediaListResponse,
  type AdminSummaryResponse,
  type AdminVmDetail,
  type AgentListResponse,
  type AgentSummary,
  type AuthenticatedSession,
  type DiscoveryOperation,
  type DiscoveryStateResponse,
  type EmulatorType,
  type InfoResponse,
  type MediaVisibility,
  type PairingRequestListResponse,
  type PairingRequestReview,
  type PublicCatalogResponse,
  type PublicVmDetail,
  type RevokedSessionsResponse,
  type SessionListResponse,
  type SessionStateResponse,
  type SetupRequest,
  type SetupStatusResponse,
  type UpdateVmMetadataRequest,
  type VmIdentity,
  type VmVisibility,
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

export interface FieldProblem {
  path: string;
  message: string;
}

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';

  constructor(
    /** 0 means no HTTP response came back at all. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly FieldProblem[] = [],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const UNREACHABLE_MESSAGE = 'The server could not be reached. Check your connection and try again.';

/** Set while signed in. Held in memory only, and re-read from the server on each page load. */
let csrfToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when the server says the session is gone, so that the app can show the signed-out view. */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal: signal ?? null,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiRequestError(0, 'unreachable', UNREACHABLE_MESSAGE);
  }
  if (response.ok) return response;

  let payload: { error?: { code?: string; message?: string; details?: FieldProblem[] } } = {};
  try {
    payload = await response.json();
  } catch {
    // A failing proxy answers with something other than the API's JSON.
  }
  const code = payload.error?.code;
  if (!code) throw new ApiRequestError(response.status, 'unreachable', UNREACHABLE_MESSAGE);
  if (code === 'unauthenticated') onSessionLost?.();
  const retryAfter = Number(response.headers.get('retry-after'));
  throw new ApiRequestError(
    response.status,
    code,
    payload.error?.message ?? 'The request failed',
    payload.error?.details ?? [],
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** What this file needs from a schema in the contracts package. */
interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function requestJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiRequestError(response.status, 'unexpected_response', UNREACHABLE_MESSAGE);
  }
  return parsed.data;
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Drops the API prefix, since the helpers in contracts return complete paths. */
function relative(path: string): string {
  return path.slice(API_PREFIX.length);
}

// Setup and authentication

export function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatusResponse> {
  return requestJson('/setup/status', setupStatusResponseSchema, { signal });
}

export function completeSetup(request: SetupRequest): Promise<AuthenticatedSession> {
  return requestJson('/setup', authenticatedSessionSchema, { method: 'POST', body: request });
}

export function fetchSessionState(signal?: AbortSignal): Promise<SessionStateResponse> {
  return requestJson('/auth/session', sessionStateResponseSchema, { signal });
}

export function login(username: string, password: string): Promise<AuthenticatedSession> {
  return requestJson('/auth/login', authenticatedSessionSchema, {
    method: 'POST',
    body: { username, password },
  });
}

export async function logout(): Promise<void> {
  await send('/auth/logout', { method: 'POST' });
}

export function fetchSessions(signal?: AbortSignal): Promise<SessionListResponse> {
  return requestJson('/account/sessions', sessionListResponseSchema, { signal });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await send(`/account/sessions/${sessionId}`, { method: 'DELETE' });
}

export function revokeOtherSessions(): Promise<RevokedSessionsResponse> {
  return requestJson('/account/sessions/revoke-others', revokedSessionsResponseSchema, {
    method: 'POST',
  });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<RevokedSessionsResponse> {
  return requestJson('/account/password', revokedSessionsResponseSchema, {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

// Public catalog

export interface CatalogFilters {
  q?: string | undefined;
  emulatorType?: EmulatorType | undefined;
  page: number;
}

export function fetchPublicCatalog(
  filters: CatalogFilters,
  signal?: AbortSignal,
): Promise<PublicCatalogResponse> {
  return requestJson(`/catalog/vms${queryString({ ...filters })}`, publicCatalogResponseSchema, {
    signal,
  });
}

export function fetchPublicVm(vm: VmIdentity, signal?: AbortSignal): Promise<PublicVmDetail> {
  return requestJson(relative(publicVmApiPath(vm)), publicVmDetailSchema, { signal });
}

// Administration

export function fetchAdminSummary(signal?: AbortSignal): Promise<AdminSummaryResponse> {
  return requestJson('/admin/summary', adminSummaryResponseSchema, { signal });
}

export function fetchAdminCatalog(
  filters: CatalogFilters & { visibility?: VmVisibility | undefined },
  signal?: AbortSignal,
): Promise<AdminCatalogResponse> {
  return requestJson(`/admin/vms${queryString({ ...filters })}`, adminCatalogResponseSchema, {
    signal,
  });
}

export function fetchAdminVm(vm: VmIdentity, signal?: AbortSignal): Promise<AdminVmDetail> {
  return requestJson(relative(adminVmApiPath(vm)), adminVmDetailSchema, { signal });
}

export function updateVmMetadata(
  vm: VmIdentity,
  changes: UpdateVmMetadataRequest,
): Promise<AdminVmDetail> {
  return requestJson(relative(adminVmApiPath(vm)), adminVmDetailSchema, {
    method: 'PATCH',
    body: changes,
  });
}

export function updateVmVisibility(
  vm: VmIdentity,
  visibility: VmVisibility,
): Promise<AdminVmDetail> {
  return requestJson(`${relative(adminVmApiPath(vm))}/visibility`, adminVmDetailSchema, {
    method: 'PUT',
    body: { visibility },
  });
}

export function fetchVmMedia(
  vm: VmIdentity,
  signal?: AbortSignal,
): Promise<AdminMediaListResponse> {
  return requestJson(`${relative(adminVmApiPath(vm))}/media`, adminMediaListResponseSchema, {
    signal,
  });
}

export function selectMainMedia(vm: VmIdentity, mediaId: string): Promise<AdminMediaListResponse> {
  return requestJson(`${relative(adminVmApiPath(vm))}/main-media`, adminMediaListResponseSchema, {
    method: 'PUT',
    body: { mediaId },
  });
}

export function clearMainMedia(vm: VmIdentity): Promise<AdminMediaListResponse> {
  return requestJson(`${relative(adminVmApiPath(vm))}/main-media`, adminMediaListResponseSchema, {
    method: 'DELETE',
  });
}

export function updateMediaVisibility(
  vm: VmIdentity,
  mediaId: string,
  visibility: MediaVisibility,
): Promise<AdminMediaListResponse> {
  return requestJson(
    `${relative(adminVmApiPath(vm))}/media/${mediaId}/visibility`,
    adminMediaListResponseSchema,
    { method: 'PUT', body: { visibility } },
  );
}

export function deleteMedia(vm: VmIdentity, mediaId: string): Promise<AdminMediaListResponse> {
  return requestJson(
    `${relative(adminVmApiPath(vm))}/media/${mediaId}`,
    adminMediaListResponseSchema,
    {
      method: 'DELETE',
    },
  );
}

// Agents

export function fetchAgents(signal?: AbortSignal): Promise<AgentListResponse> {
  return requestJson('/admin/agents', agentListResponseSchema, { signal });
}

export function fetchAgent(agentId: string, signal?: AbortSignal): Promise<AgentSummary> {
  return requestJson(`/admin/agents/${encodeURIComponent(agentId)}`, agentSummarySchema, {
    signal,
  });
}

export function revokeAgent(agentId: string): Promise<AgentSummary> {
  return requestJson(`/admin/agents/${encodeURIComponent(agentId)}/revoke`, agentSummarySchema, {
    method: 'POST',
  });
}

export function fetchPendingPairingRequests(
  signal?: AbortSignal,
): Promise<PairingRequestListResponse> {
  return requestJson('/admin/agent-pairing/requests', pairingRequestListResponseSchema, { signal });
}

export function fetchPairingRequest(
  requestId: string,
  signal?: AbortSignal,
): Promise<PairingRequestReview> {
  return requestJson(`/admin/agent-pairing/requests/${requestId}`, pairingRequestReviewSchema, {
    signal,
  });
}

export function lookUpPairing(code: string): Promise<PairingRequestReview> {
  return requestJson('/admin/agent-pairing/lookup', pairingRequestReviewSchema, {
    method: 'POST',
    body: { code },
  });
}

export function approvePairing(requestId: string, code: string): Promise<PairingRequestReview> {
  return requestJson(
    `/admin/agent-pairing/requests/${requestId}/approve`,
    pairingRequestReviewSchema,
    { method: 'POST', body: { code } },
  );
}

export function rejectPairing(requestId: string): Promise<PairingRequestReview> {
  return requestJson(
    `/admin/agent-pairing/requests/${requestId}/reject`,
    pairingRequestReviewSchema,
    { method: 'POST' },
  );
}

export function fetchDiscovery(
  agentId: string,
  signal?: AbortSignal,
): Promise<DiscoveryStateResponse> {
  return requestJson(
    `/admin/agents/${encodeURIComponent(agentId)}/discovery`,
    discoveryStateResponseSchema,
    { signal },
  );
}

export function startDiscovery(agentId: string): Promise<DiscoveryOperation> {
  return requestJson(
    `/admin/agents/${encodeURIComponent(agentId)}/discovery`,
    discoveryOperationSchema,
    { method: 'POST' },
  );
}
