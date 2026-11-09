import {
  adminCatalogResponseSchema,
  adminMediaListResponseSchema,
  adminMediaSyncResponseSchema,
  adminSummaryResponseSchema,
  adminVmApiPath,
  adminVmDetailSchema,
  agentListResponseSchema,
  applicationUpdatesResponseSchema,
  agentSummarySchema,
  API_PREFIX,
  authenticatedSessionSchema,
  CSRF_HEADER,
  discoveryOperationSchema,
  discoveryStateResponseSchema,
  executionOptionsResponseSchema,
  infoResponseSchema,
  pairingRequestListResponseSchema,
  pairingRequestReviewSchema,
  publicCatalogResponseSchema,
  publicVmApiPath,
  publicVmDetailSchema,
  readyResponseSchema,
  registrationListResponseSchema,
  registrationOperationSchema,
  repositoryListResponseSchema,
  repositorySummarySchema,
  restoreListResponseSchema,
  restoreOperationSchema,
  restoreOptionsResponseSchema,
  revokedSessionsResponseSchema,
  sessionListResponseSchema,
  sessionStateResponseSchema,
  updateLogResponseSchema,
  updateOperationSchema,
  setupStatusResponseSchema,
  vmSessionListResponseSchema,
  vmSessionSchema,
  vmVerificationSchema,
  type AdminCatalogResponse,
  type AdminMediaListResponse,
  type AdminMediaSyncResponse,
  type AdminSummaryResponse,
  type AdminVmDetail,
  type AgentListResponse,
  type ApplicationUpdatesResponse,
  type AgentSummary,
  type AuthenticatedSession,
  type CreateRegistrationRequest,
  type CreateRestoreRequest,
  type DiscoveryOperation,
  type DiscoveryStateResponse,
  type EmulatorType,
  type ExecutionOptionsResponse,
  type LaunchRequest,
  type StopSessionRequest,
  type VerifyRequest,
  type VmSession,
  type VmSessionListResponse,
  type VmVerification,
  type InfoResponse,
  type PairingRequestListResponse,
  type PairingRequestReview,
  type PublicCatalogResponse,
  type PublicVmDetail,
  type RegistrationListResponse,
  type RegistrationOperation,
  type RepositoryListResponse,
  type RepositorySummary,
  type RestoreListResponse,
  type RestoreOperation,
  type RestoreOptionsResponse,
  type SaveRepositoryRequest,
  type RevokedSessionsResponse,
  type SessionListResponse,
  type SessionStateResponse,
  type SetupRequest,
  type SetupStatusResponse,
  type UpdateLogResponse,
  type UpdateOperation,
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

export function fetchVmMediaSync(
  vm: VmIdentity,
  signal: AbortSignal,
): Promise<AdminMediaSyncResponse> {
  return requestJson(`${relative(adminVmApiPath(vm))}/media-sync`, adminMediaSyncResponseSchema, {
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

// Registration and repositories. Nothing here ever carries archive bytes, a path or a key.

export function fetchRegistrations(
  agentId: string | undefined,
  signal?: AbortSignal,
): Promise<RegistrationListResponse> {
  return requestJson(
    `/admin/registrations${queryString({ agentId })}`,
    registrationListResponseSchema,
    { signal },
  );
}

export function startRegistration(
  request: CreateRegistrationRequest,
): Promise<RegistrationOperation> {
  return requestJson('/admin/registrations', registrationOperationSchema, {
    method: 'POST',
    body: request,
  });
}

export function cancelRegistration(operationId: string): Promise<RegistrationOperation> {
  return requestJson(
    `/admin/registrations/${encodeURIComponent(operationId)}/cancel`,
    registrationOperationSchema,
    { method: 'POST' },
  );
}

export function retryRegistrationCleanup(operationId: string): Promise<RegistrationOperation> {
  return requestJson(
    `/admin/registrations/${encodeURIComponent(operationId)}/retry-cleanup`,
    registrationOperationSchema,
    { method: 'POST' },
  );
}

export function reconcileRegistration(operationId: string): Promise<RegistrationOperation> {
  return requestJson(
    `/admin/registrations/${encodeURIComponent(operationId)}/reconcile`,
    registrationOperationSchema,
    { method: 'POST' },
  );
}

export function fetchRepositories(signal?: AbortSignal): Promise<RepositoryListResponse> {
  return requestJson('/admin/repositories', repositoryListResponseSchema, { signal });
}

export function createRepository(request: SaveRepositoryRequest): Promise<RepositorySummary> {
  return requestJson('/admin/repositories', repositorySummarySchema, {
    method: 'POST',
    body: request,
  });
}

export function updateRepository(
  repositoryId: string,
  request: SaveRepositoryRequest,
): Promise<RepositorySummary> {
  return requestJson(
    `/admin/repositories/${encodeURIComponent(repositoryId)}`,
    repositorySummarySchema,
    { method: 'PUT', body: request },
  );
}

const repositoryAgentPath = (repositoryId: string, agentId: string) =>
  `/admin/repositories/${encodeURIComponent(repositoryId)}/agents/${encodeURIComponent(agentId)}`;

export function associateRepositoryAgent(
  repositoryId: string,
  agentId: string,
): Promise<RepositorySummary> {
  return requestJson(repositoryAgentPath(repositoryId, agentId), repositorySummarySchema, {
    method: 'PUT',
  });
}

export function dissociateRepositoryAgent(
  repositoryId: string,
  agentId: string,
): Promise<RepositorySummary> {
  return requestJson(repositoryAgentPath(repositoryId, agentId), repositorySummarySchema, {
    method: 'DELETE',
  });
}

export function checkRepository(repositoryId: string, agentId: string): Promise<RepositorySummary> {
  return requestJson(
    `${repositoryAgentPath(repositoryId, agentId)}/health-check`,
    repositorySummarySchema,
    { method: 'POST' },
  );
}

// Restores

export function fetchRestoreOptions(
  vm: VmIdentity,
  signal?: AbortSignal,
): Promise<RestoreOptionsResponse> {
  return requestJson(
    `${relative(adminVmApiPath(vm))}/restore-options`,
    restoreOptionsResponseSchema,
    { signal },
  );
}

export function fetchRestores(
  filter: { agentId?: string; emulatorType?: EmulatorType; vmName?: string },
  signal?: AbortSignal,
): Promise<RestoreListResponse> {
  return requestJson(`/admin/restores${queryString(filter)}`, restoreListResponseSchema, {
    signal,
  });
}

export function startRestore(request: CreateRestoreRequest): Promise<RestoreOperation> {
  return requestJson('/admin/restores', restoreOperationSchema, {
    method: 'POST',
    body: request,
  });
}

export function cancelRestore(operationId: string): Promise<RestoreOperation> {
  return requestJson(`/admin/restores/${operationId}/cancel`, restoreOperationSchema, {
    method: 'POST',
  });
}

// Running VMs, and verifying local copies

export function fetchExecutionOptions(
  vm: VmIdentity,
  signal?: AbortSignal,
): Promise<ExecutionOptionsResponse> {
  return requestJson(
    `${relative(adminVmApiPath(vm))}/execution-options`,
    executionOptionsResponseSchema,
    { signal },
  );
}

export function fetchVmSessions(
  filter: { agentId?: string; emulatorType?: EmulatorType; vmName?: string; limit?: number },
  signal?: AbortSignal,
): Promise<VmSessionListResponse> {
  return requestJson(`/admin/sessions${queryString(filter)}`, vmSessionListResponseSchema, {
    signal,
  });
}

/** Names an agent, a VM and a mode, and nothing else: the agent builds the command itself. */
export function launchVm(request: LaunchRequest): Promise<VmSession> {
  return requestJson('/admin/sessions', vmSessionSchema, { method: 'POST', body: request });
}

export function stopSession(sessionId: string, request: StopSessionRequest): Promise<VmSession> {
  return requestJson(`/admin/sessions/${sessionId}/stop`, vmSessionSchema, {
    method: 'POST',
    body: request,
  });
}

export function dismissSession(sessionId: string, confirmVmName: string): Promise<VmSession> {
  return requestJson(`/admin/sessions/${sessionId}/dismiss`, vmSessionSchema, {
    method: 'POST',
    body: { confirmVmName },
  });
}

export function verifyLocalCopy(request: VerifyRequest): Promise<VmVerification> {
  return requestJson('/admin/verifications', vmVerificationSchema, {
    method: 'POST',
    body: request,
  });
}

// Application updates. Administrators only. Nothing here sends a ref, command or repository: the server's
// deployment service decides all of that from its own configuration.

export function fetchApplicationUpdates(signal?: AbortSignal): Promise<ApplicationUpdatesResponse> {
  return requestJson('/admin/system/updates', applicationUpdatesResponseSchema, { signal });
}

export function checkForUpdates(): Promise<ApplicationUpdatesResponse> {
  return requestJson('/admin/system/updates/check', applicationUpdatesResponseSchema, {
    method: 'POST',
  });
}

/** `expectedCommit` is the commit the administrator was shown; the server refuses if the branch moved. */
export function startApplicationUpdate(expectedCommit: string): Promise<UpdateOperation> {
  return requestJson('/admin/system/updates', updateOperationSchema, {
    method: 'POST',
    body: { expectedCommit },
  });
}

export function fetchUpdateOperation(
  operationId: string,
  signal?: AbortSignal,
): Promise<UpdateOperation> {
  return requestJson(`/admin/system/updates/${operationId}`, updateOperationSchema, { signal });
}

export function fetchUpdateLog(operationId: string): Promise<UpdateLogResponse> {
  return requestJson(`/admin/system/updates/${operationId}/log`, updateLogResponseSchema);
}
