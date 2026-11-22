import { randomUUID } from 'node:crypto';
import {
  serverConnectionTestSchema,
  type RepositoryAgent,
  type RepositorySummary,
  type SaveRepositoryRequest,
  type ServerConnectionTest,
} from '@emucat/contracts';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import type { RepositoryEndpoint } from '../repository-access/ssh.js';

/**
 * SQL for repositories. Queries name every column, and never `secret_ref`. A repository's connection
 * details are not secret, but the database holds nothing that could authenticate to it: the agents' private keys
 * stay on the agents, and the server's own key is a file on the server (decision 0055).
 */

interface RepositoryRow extends RowDataPacket {
  id: string;
  name: string;
  kind: string;
  config: string | Record<string, unknown>;
  enabled: number | boolean;
}

interface AssociationRow extends RowDataPacket {
  repository_id: string;
  agent_id: string;
  agent_name: string;
  revoked_at: Date | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  host_key_fingerprint: string | null;
  free_bytes: number | string | null;
  last_transport: 'sftp' | 'relay' | null;
}

interface StoredConfig {
  host: string;
  port: number;
  username: string;
  remoteRoot: string;
  /** Decision 0055. Absent from records written before it. */
  serverHost?: string | null;
  serverPort?: number | null;
}

function configOf(row: { config: string | Record<string, unknown> }): StoredConfig {
  return (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as StoredConfig;
}

/**
 * Where the server itself connects for a repository: its server-side address when one is recorded, the agents'
 * otherwise. Username and remote root are the repository's, always. Nothing in a request can change any of it.
 */
export function endpointOf(repositoryId: string, config: StoredConfig): RepositoryEndpoint {
  const serverHost = config.serverHost ?? null;
  const serverPort = config.serverPort ?? null;
  return {
    repositoryId,
    host: serverHost ?? config.host,
    port: serverPort ?? config.port,
    username: config.username,
    remoteRoot: config.remoteRoot,
    addressSource: serverHost !== null || serverPort !== null ? 'server' : 'repository',
  };
}

export interface RepositoryRecord {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: RepositoryEndpoint;
}

export async function repositoryRecord(
  executor: Pool | PoolConnection,
  repositoryId: string,
): Promise<RepositoryRecord | null> {
  const [rows] = await executor.execute<RepositoryRow[]>(
    "SELECT id, name, kind, config, enabled FROM repositories WHERE id = ? AND kind = 'sftp'",
    [repositoryId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    endpoint: endpointOf(row.id, configOf(row)),
  };
}

export async function recordServerCheck(
  pool: Pool,
  repositoryId: string,
  result: ServerConnectionTest,
): Promise<void> {
  await pool.execute(
    `INSERT INTO repository_server_checks (repository_id, tested_at, ok, result)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE tested_at = VALUES(tested_at), ok = VALUES(ok), result = VALUES(result)`,
    [repositoryId, new Date(result.testedAt), result.ok, JSON.stringify(result)],
  );
}

async function serverChecks(pool: Pool): Promise<Map<string, ServerConnectionTest>> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT repository_id, result FROM repository_server_checks',
  );
  const checks = new Map<string, ServerConnectionTest>();
  for (const row of rows) {
    const raw = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    const parsed = serverConnectionTestSchema.safeParse(raw);
    if (parsed.success) checks.set(row.repository_id as string, parsed.data);
  }
  return checks;
}

export interface RepositoryPresence {
  isOnline(agentId: string): boolean;
  isHealthCheckRunning(repositoryId: string, agentId: string): boolean;
  /** Whether this server has a key for its own repository connection. */
  serverAccessConfigured?: boolean;
}

function summarize(
  row: RepositoryRow,
  associations: AssociationRow[],
  presence: RepositoryPresence,
  serverCheck: ServerConnectionTest | null,
): RepositorySummary {
  const config = configOf(row);
  const agents: RepositoryAgent[] = associations.map((association) => ({
    agentId: association.agent_id,
    agentName: association.agent_name,
    online: presence.isOnline(association.agent_id),
    revoked: association.revoked_at !== null,
    checkInProgress: presence.isHealthCheckRunning(row.id, association.agent_id),
    lastCheckedAt: association.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: association.last_success_at?.toISOString() ?? null,
    errorCode: association.last_error_code,
    errorMessage: association.last_error_message,
    hostKeyFingerprint: association.host_key_fingerprint,
    freeBytes: association.free_bytes === null ? null : Number(association.free_bytes),
    transport: association.last_transport,
  }));
  const successes = associations
    .map((association) => association.last_success_at)
    .filter((when): when is Date => when !== null)
    .map((when) => when.getTime());
  const errors = agents
    .filter((agent) => agent.errorCode !== null)
    .map((agent) => `${agent.agentName}: ${agent.errorMessage ?? agent.errorCode}`);
  return {
    id: row.id,
    name: row.name,
    provider: 'sftp',
    host: config.host,
    port: config.port,
    username: config.username,
    remoteRoot: config.remoteRoot,
    serverHost: config.serverHost ?? null,
    serverPort: config.serverPort ?? null,
    enabled: Boolean(row.enabled),
    status: errors.length > 0 ? 'failing' : successes.length > 0 ? 'healthy' : 'unchecked',
    lastSuccessfulCheckAt:
      successes.length > 0 ? new Date(Math.max(...successes)).toISOString() : null,
    agents,
    configurationErrors: errors,
    serverAccess: {
      configured: presence.serverAccessConfigured ?? false,
      lastTest: serverCheck,
    },
  };
}

export async function listRepositories(
  pool: Pool,
  presence: RepositoryPresence,
): Promise<RepositorySummary[]> {
  const [rows] = await pool.execute<RepositoryRow[]>(
    `SELECT id, name, kind, config, enabled FROM repositories
     WHERE kind = 'sftp' ORDER BY enabled DESC, name, id`,
  );
  const [associations] = await pool.execute<AssociationRow[]>(
    `SELECT ar.repository_id, ar.agent_id, a.name AS agent_name, a.revoked_at,
            ar.last_checked_at, ar.last_success_at, ar.last_error_code, ar.last_error_message,
            ar.host_key_fingerprint, ar.free_bytes, ar.last_transport
     FROM agent_repositories AS ar
     JOIN agents AS a ON a.id = ar.agent_id
     ORDER BY a.name, a.id`,
  );
  const checks = await serverChecks(pool);
  return rows.map((row) =>
    summarize(
      row,
      associations.filter((association) => association.repository_id === row.id),
      presence,
      checks.get(row.id) ?? null,
    ),
  );
}

export async function getRepository(
  pool: Pool,
  repositoryId: string,
  presence: RepositoryPresence,
): Promise<RepositorySummary> {
  const all = await listRepositories(pool, presence);
  const found = all.find((repository) => repository.id === repositoryId);
  if (!found) throw new ApiError(404, 'repository_not_found', 'Repository not found');
  return found;
}

function configJson(request: SaveRepositoryRequest): string {
  const { host, port, username, remoteRoot } = request;
  const serverHost = request.serverHost ?? null;
  const serverPort = request.serverPort ?? null;
  return JSON.stringify({ host, port, username, remoteRoot, serverHost, serverPort });
}

export async function createRepository(
  pool: Pool,
  request: SaveRepositoryRequest,
): Promise<string> {
  const id = randomUUID();
  try {
    await pool.execute(
      "INSERT INTO repositories (id, name, kind, config) VALUES (?, ?, 'sftp', ?)",
      [id, request.name, configJson(request)],
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new ApiError(
        409,
        'repository_exists',
        'There is already an active SSH repository, or one with this name.',
      );
    }
    throw error;
  }
  return id;
}

/** Changing where a repository points invalidates every earlier check of it. */
export async function updateRepository(
  pool: Pool,
  repositoryId: string,
  request: SaveRepositoryRequest,
): Promise<void> {
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE repositories SET name = ?, config = ? WHERE id = ? AND kind = 'sftp'",
    [request.name, configJson(request), repositoryId],
  );
  if (result.affectedRows === 0) {
    throw new ApiError(404, 'repository_not_found', 'Repository not found');
  }
  await pool.execute(
    `UPDATE agent_repositories
     SET last_checked_at = NULL, last_success_at = NULL, last_error_code = NULL,
         last_error_message = NULL, host_key_fingerprint = NULL, free_bytes = NULL, last_transport = NULL
     WHERE repository_id = ?`,
    [repositoryId],
  );
  // The server's own test described the old address too.
  await pool.execute('DELETE FROM repository_server_checks WHERE repository_id = ?', [
    repositoryId,
  ]);
}

export async function associateAgent(
  pool: Pool,
  repositoryId: string,
  agentId: string,
): Promise<void> {
  const [agents] = await pool.execute<RowDataPacket[]>(
    'SELECT revoked_at FROM agents WHERE id = ?',
    [agentId],
  );
  if (!agents[0]) throw new ApiError(404, 'agent_not_found', 'Agent not found');
  if (agents[0].revoked_at) {
    throw new ApiError(409, 'agent_revoked', 'This agent has been revoked.');
  }
  const [repositories] = await pool.execute<RowDataPacket[]>(
    'SELECT 1 FROM repositories WHERE id = ?',
    [repositoryId],
  );
  if (!repositories[0]) throw new ApiError(404, 'repository_not_found', 'Repository not found');
  await pool.execute(
    'INSERT IGNORE INTO agent_repositories (agent_id, repository_id) VALUES (?, ?)',
    [agentId, repositoryId],
  );
}

export async function dissociateAgent(
  pool: Pool,
  repositoryId: string,
  agentId: string,
): Promise<void> {
  await pool.execute('DELETE FROM agent_repositories WHERE agent_id = ? AND repository_id = ?', [
    agentId,
    repositoryId,
  ]);
}

export async function isAgentAssociated(
  pool: Pool,
  repositoryId: string,
  agentId: string,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT 1 FROM agent_repositories WHERE agent_id = ? AND repository_id = ?',
    [agentId, repositoryId],
  );
  return rows.length > 0;
}

export async function recordHealthResult(
  pool: Pool,
  repositoryId: string,
  agentId: string,
  ok: boolean,
  code: string | null,
  message: string | null,
  fingerprint: string | null,
  freeBytes: number | null,
  transport: 'sftp' | 'relay' | null = null,
): Promise<void> {
  await pool.execute(
    `UPDATE agent_repositories
     SET last_checked_at = UTC_TIMESTAMP(3),
         last_success_at = IF(?, UTC_TIMESTAMP(3), last_success_at),
         last_error_code = ?, last_error_message = ?,
         host_key_fingerprint = COALESCE(?, host_key_fingerprint), free_bytes = ?, last_transport = ?
     WHERE agent_id = ? AND repository_id = ?`,
    [
      ok,
      ok ? null : code,
      ok ? null : message,
      fingerprint,
      freeBytes,
      transport,
      agentId,
      repositoryId,
    ],
  );
}
