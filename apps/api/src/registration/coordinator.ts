import { randomUUID } from 'node:crypto';
import {
  SNAPSHOT_INELIGIBLE_TEXT,
  archiveObjectKey,
  formatSnapshotName,
  isRegistrationCommitted,
  isRegistrationTerminal,
  isRetryableCleanup,
  registrationRecovery,
  type CreateRegistrationRequest,
  type RegistrationAckPayload,
  type RegistrationCleanupPayload,
  type RegistrationErrorPayload,
  type RegistrationOperation,
  type RegistrationProgressPayload,
  type RegistrationRequestPayload,
  type RegistrationResultPayload,
  type RegistrationState,
  type RegistrationSyncPayload,
  type RepositoryHealthResultPayload,
  type ServerMessage,
  type SnapshotIneligibleReason,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DiscoveryRecord } from '../agents/discovery.js';
import { lockUsableVersion } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import { recordHealthResult } from './repositories.js';

/** What the coordinator needs from the hub, which owns the sockets. */
export interface AgentLink {
  isOnline(agentId: string): boolean;
  isRegistrationCapable(agentId: string): boolean;
  /** Whether this connection's agent said it can create snapshots. */
  isSnapshotCapable(agentId: string): boolean;
  activeConnectionId(agentId: string): string | null;
  latestDiscovery(agentId: string): DiscoveryRecord | null;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

export interface RegistrationPolicy {
  /** A discovery older than this says too little about the disk to act on. */
  discoveryMaxAgeMs: number;
  healthCheckTimeoutMs: number;
}

export const DEFAULT_REGISTRATION_POLICY: RegistrationPolicy = {
  discoveryMaxAgeMs: 15 * 60 * 1000,
  healthCheckTimeoutMs: 120_000,
};

interface OperationRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_revoked_at: Date | null;
  repository_id: string;
  repository_name: string;
  requested_by_user_id: string | null;
  requested_by_display_name: string | null;
  emulator_type: RegistrationOperation['emulatorType'];
  vm_name: string;
  mode: RegistrationOperation['mode'];
  state: RegistrationState;
  version_id: string;
  parent_version_id: string | null;
  snapshot_name: string | null;
  workspace_id: string | null;
  request_id: string | null;
  archive_key: string;
  progress_done_bytes: number | string | null;
  progress_total_bytes: number | string | null;
  archive_size_bytes: number | string | null;
  archive_sha256: string | null;
  manifest_version: number | null;
  manifest_sha256: string | null;
  file_count: number | string | null;
  total_uncompressed_bytes: number | string | null;
  local_copy: RegistrationOperation['localCopy'];
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: Date | null;
  committed_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const OPERATION_QUERY = `
  SELECT op.id, op.agent_id, a.name AS agent_name, a.revoked_at AS agent_revoked_at,
         op.repository_id, r.name AS repository_name,
         op.requested_by_user_id, u.display_name AS requested_by_display_name,
         op.emulator_type, op.vm_name, op.mode, op.state, op.version_id, op.archive_key,
         op.parent_version_id, op.snapshot_name, op.workspace_id, op.request_id,
         op.progress_done_bytes, op.progress_total_bytes,
         op.archive_size_bytes, op.archive_sha256, op.manifest_version, op.manifest_sha256,
         op.file_count, op.total_uncompressed_bytes, op.local_copy,
         op.error_code, op.error_message, op.cancel_requested_at,
         op.committed_at, op.finished_at, op.created_at, op.updated_at
  FROM registration_operations AS op
  JOIN agents AS a ON a.id = op.agent_id
  JOIN repositories AS r ON r.id = op.repository_id
  LEFT JOIN users AS u ON u.id = op.requested_by_user_id`;

const ACTIVE_STATES = [
  'queued',
  'validating',
  'archiving',
  'uploading',
  'verifying',
  'committing',
  'cleaning_local',
] as const;

/** The states from which an agent's report of progress at each stage is believed. */
const STAGE_ALLOWED_FROM: Record<
  RegistrationProgressPayload['stage'],
  readonly RegistrationState[]
> = {
  validating: ['queued', 'validating'],
  archiving: ['queued', 'validating', 'archiving'],
  // Back and forth, since a failed verification is retried by uploading again.
  uploading: ['queued', 'validating', 'archiving', 'uploading', 'verifying'],
  verifying: ['uploading', 'verifying'],
  cleaning_local: ['cleaning_local'],
};

const toNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

function toOperation(row: OperationRow, online: boolean): RegistrationOperation {
  const hasArchive = row.archive_sha256 !== null && row.manifest_sha256 !== null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentOnline: online,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    mode: row.mode,
    state: row.state,
    versionId: row.version_id,
    parentVersionId: row.parent_version_id,
    snapshotName: row.snapshot_name,
    workspaceId: row.workspace_id,
    archiveKey: row.archive_key,
    progress: {
      doneBytes: toNumber(row.progress_done_bytes),
      totalBytes: toNumber(row.progress_total_bytes),
    },
    archive: hasArchive
      ? {
          sizeBytes: Number(row.archive_size_bytes),
          sha256: row.archive_sha256 as string,
          manifestVersion: Number(row.manifest_version),
          manifestSha256: row.manifest_sha256 as string,
          fileCount: Number(row.file_count),
          totalUncompressedBytes: Number(row.total_uncompressed_bytes),
          verifiedBy: 'agent',
        }
      : null,
    localCopy: row.local_copy,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    recovery: row.error_code ? registrationRecovery(row.error_code) : null,
    cancelRequested: row.cancel_requested_at !== null,
    requestedByDisplayName: row.requested_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    committedAt: row.committed_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** What goes to the agent for an operation, from its row. Snapshot fields only when there are any. */
function requestFor(row: OperationRow): RegistrationRequestPayload {
  return {
    operationId: row.id,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    mode: row.mode,
    repositoryId: row.repository_id,
    versionId: row.version_id,
    archiveKey: row.archive_key,
    ...(row.parent_version_id ? { parentVersionId: row.parent_version_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
  };
}

const refuseSnapshot = (reason: SnapshotIneligibleReason, status = 409) =>
  new ApiError(status, reason, SNAPSHOT_INELIGIBLE_TEXT[reason]);

export interface SnapshotInput {
  agentId: string;
  parentVersionId: string;
  requestId: string;
  /** Preserve this Remote Snapshot working copy, rather than the persistent local VM. */
  workspaceId?: string | undefined;
}

const FAILURE_TEXT: Record<string, string> = {
  agent_revoked: 'The agent was revoked before this finished.',
  agent_lost_operation: 'The agent no longer knows about this operation.',
  invalid_result: 'The agent reported a result that does not belong to this operation.',
  duplicate_registration: 'This VM was registered by something else in the meantime.',
  repository_not_authorized: 'This agent is no longer allowed to use this repository.',
};

/**
 * Registration on the server's side. It holds no state of its own: everything is in
 * `registration_operations`, so a restart loses nothing. Everything an agent reports is checked against
 * that row, and only an operation an administrator created can ever produce a master.
 *
 * All the handlers are idempotent, because an agent repeats a report until it gets an answer.
 */
export class RegistrationCoordinator {
  private readonly healthTimers = new Map<string, NodeJS.Timeout>();
  /** `repositoryId/agentId` of the health checks in progress. Their results are stored when they come. */
  private readonly healthChecks = new Map<string, string>();

  constructor(
    private readonly pool: Pool,
    private readonly link: AgentLink,
    private readonly log: FastifyBaseLogger,
    private readonly policy: RegistrationPolicy = DEFAULT_REGISTRATION_POLICY,
  ) {}

  /**
   * Called when a snapshot of a working copy may have changed state, so that a remote session can move
   * on (decision 0040). A missed call is harmless: the remote sessions' sweep looks again.
   */
  onWorkspaceSnapshot: ((workspaceId: string) => void) | null = null;

  private async notifyWorkspace(operationId: string): Promise<void> {
    if (!this.onWorkspaceSnapshot) return;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT workspace_id FROM registration_operations WHERE id = ?',
      [operationId],
    );
    const workspaceId = rows[0]?.workspace_id as string | null | undefined;
    if (workspaceId) this.onWorkspaceSnapshot(workspaceId);
  }

  close(): void {
    for (const timer of this.healthTimers.values()) clearTimeout(timer);
    this.healthTimers.clear();
  }

  // What an administrator does.

  async create(input: CreateRegistrationRequest, userId: string): Promise<RegistrationOperation> {
    const { agentId, repositoryId, emulatorType, vmName, mode } = input;
    this.requireFreshDiscovery(input);

    const operationId = randomUUID();
    const versionId = randomUUID();
    const archiveKey = archiveObjectKey({ emulatorType, vmName }, versionId);

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
        [agentId],
      );
      if (!agents[0]) throw new ApiError(404, 'agent_not_found', 'Agent not found');
      if (agents[0].revoked_at) {
        throw new ApiError(409, 'agent_revoked', 'This agent has been revoked.');
      }
      // A restore creating itself holds this row's exclusive lock, so the two cannot start together.
      const [restores] = await connection.execute<RowDataPacket[]>(
        `SELECT 'restore' AS kind FROM restore_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL
         SELECT 'verification' FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
         UNION ALL
         SELECT 'local copy removal' FROM local_copy_removals
           WHERE agent_id = ? AND active_marker = 1`,
        [agentId, agentId, agentId],
      );
      if (restores.length > 0) {
        throw new ApiError(
          409,
          'registration_in_progress',
          `A ${restores[0]?.kind as string} is running on this agent. Wait for it to finish.`,
        );
      }
      const [repositories] = await connection.execute<RowDataPacket[]>(
        `SELECT r.enabled, ar.agent_id
         FROM repositories AS r
         LEFT JOIN agent_repositories AS ar ON ar.repository_id = r.id AND ar.agent_id = ?
         WHERE r.id = ?`,
        [agentId, repositoryId],
      );
      const repository = repositories[0];
      if (!repository) throw new ApiError(404, 'repository_not_found', 'Repository not found');
      if (!repository.enabled) {
        throw new ApiError(409, 'repository_disabled', 'This repository is disabled.');
      }
      if (!repository.agent_id) {
        throw new ApiError(
          409,
          'repository_not_authorized',
          'This agent is not associated with this repository.',
        );
      }
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
        [emulatorType, vmName],
      );
      if (existing[0]) {
        throw new ApiError(409, 'vm_already_registered', 'This VM is already registered.');
      }
      try {
        await connection.execute(
          `INSERT INTO registration_operations
             (id, agent_id, repository_id, requested_by_user_id, emulator_type, vm_name, mode,
              version_id, archive_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            repositoryId,
            userId,
            emulatorType,
            vmName,
            mode,
            versionId,
            archiveKey,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ApiError(
            409,
            'registration_in_progress',
            'A registration is already running for this VM or on this agent.',
          );
        }
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // If this cannot be delivered, the operation stays queued and goes out when the agent reconnects.
    this.dispatch(
      {
        operationId,
        emulatorType,
        vmName,
        mode,
        repositoryId,
        versionId,
        archiveKey,
      },
      agentId,
    );
    return this.require(operationId);
  }

  /**
   * A snapshot of a registered VM: the agent's persistent copy, or one of its working copies. The parent
   * must be the version those files came from; the agent checks that again against its own state. A
   * repeated request finds the operation it already created, whatever happened since. See decision 0037.
   */
  async createSnapshot(
    vm: VmIdentity,
    input: SnapshotInput,
    userId: string | null,
  ): Promise<RegistrationOperation> {
    const { agentId, parentVersionId, requestId } = input;
    const workspaceId = input.workspaceId ?? null;
    const repeated = await this.byRequest(requestId);
    if (repeated) return this.sameSnapshotRequest(repeated, vm, input);

    if (!this.link.isOnline(agentId)) throw refuseSnapshot('agent_offline');
    if (!this.link.isRegistrationCapable(agentId) || !this.link.isSnapshotCapable(agentId)) {
      throw refuseSnapshot('agent_cannot_snapshot');
    }

    const operationId = randomUUID();
    const versionId = randomUUID();
    let canonicalName: string;
    let repositoryId: string;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Shared, as a registration's: restore and launch take it exclusively, so none start alongside.
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
        [agentId],
      );
      if (!agents[0] || !agents[0].paired_at) {
        throw new ApiError(404, 'agent_not_found', 'Agent not found');
      }
      if (agents[0].revoked_at) throw refuseSnapshot('agent_revoked');

      // Scoped to the VM: a version of another VM is simply not found.
      const [versions] = await connection.execute<RowDataPacket[]>(
        `SELECT version.vm_name, version.repository_id, r.enabled, ar.agent_id AS authorized
         FROM vm_versions AS version
         JOIN repositories AS r ON r.id = version.repository_id
         LEFT JOIN agent_repositories AS ar
           ON ar.repository_id = version.repository_id AND ar.agent_id = ?
         WHERE version.id = ? AND version.emulator_type = ? AND version.vm_name = ?`,
        [agentId, parentVersionId, vm.emulatorType, vm.vmName],
      );
      const parent = versions[0];
      if (!parent) throw new ApiError(404, 'version_not_found', 'Version not found');
      canonicalName = parent.vm_name as string;
      repositoryId = parent.repository_id as string;
      if (!parent.enabled) throw refuseSnapshot('repository_disabled');
      if (!parent.authorized) throw refuseSnapshot('repository_not_authorized');
      // A deleted parent can have no children (decision 0041).
      await lockUsableVersion(connection, parentVersionId);

      const [busy] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM restore_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM registration_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM registration_operations
           WHERE emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [agentId, agentId, agentId, agentId, vm.emulatorType, canonicalName],
      );
      if (busy.length > 0) throw refuseSnapshot('operation_in_progress');
      // Unknown sessions count: an emulator that may be running describes no moment of its disks.
      const [sessions] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM vm_sessions
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [agentId, vm.emulatorType, canonicalName],
      );
      if (sessions.length > 0) throw refuseSnapshot('vm_running');

      if (workspaceId) {
        const [workspaces] = await connection.execute<RowDataPacket[]>(
          `SELECT state, purpose, source_version_id FROM vm_workspaces
           WHERE id = ? AND agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          [workspaceId, agentId, vm.emulatorType, canonicalName],
        );
        const workspace = workspaces[0];
        if (!workspace) throw new ApiError(404, 'workspace_not_found', 'Working copy not found');
        // A Remote Volatile copy is never published, and a Remote Snapshot one only by its own lifecycle,
        // once its session has ended (decision 0040). A Milestone 7 one is preserved by hand when ready.
        if (workspace.purpose === 'remote_volatile') {
          throw new ApiError(
            409,
            'workspace_purpose_mismatch',
            'This is a Remote Volatile session: its changes are never published.',
          );
        }
        const publishable = workspace.purpose === 'manual' ? 'ready' : 'publishing';
        if (workspace.state !== publishable) {
          throw new ApiError(
            409,
            'workspace_unavailable',
            'This working copy is not ready, so it cannot be preserved.',
          );
        }
        if (workspace.source_version_id !== parentVersionId) {
          throw refuseSnapshot('snapshot_parent_mismatch');
        }
      } else {
        const [states] = await connection.execute<RowDataPacket[]>(
          `SELECT execution_state, local_source_version_id FROM agent_vm_state
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          [agentId, vm.emulatorType, canonicalName],
        );
        const state = states[0];
        if (!state || state.execution_state === 'absent')
          throw refuseSnapshot('local_copy_missing');
        if (state.execution_state === 'error') throw refuseSnapshot('local_copy_unsafe');
        // Discovery saw it disappear and come back: it may be another directory with the same name, so
        // what is recorded about it proves nothing until a verification says otherwise.
        if (state.execution_state === 'unknown')
          throw refuseSnapshot('snapshot_lineage_unverified');
        if (!state.local_source_version_id) throw refuseSnapshot('snapshot_parent_unknown');
        if (state.local_source_version_id !== parentVersionId) {
          throw refuseSnapshot('snapshot_parent_mismatch');
        }
      }

      try {
        await connection.execute(
          `INSERT INTO registration_operations
             (id, agent_id, repository_id, requested_by_user_id, request_id, emulator_type, vm_name,
              mode, version_id, parent_version_id, snapshot_name, workspace_id, archive_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'snapshot', ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            repositoryId,
            userId,
            requestId,
            vm.emulatorType,
            canonicalName,
            versionId,
            parentVersionId,
            formatSnapshotName(canonicalName, new Date()),
            workspaceId,
            archiveObjectKey({ emulatorType: vm.emulatorType, vmName: canonicalName }, versionId),
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) throw refuseSnapshot('operation_in_progress');
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // Two identical requests at once: the loser finds the winner's operation.
      if (error instanceof ApiError && error.code === 'operation_in_progress') {
        const winner = await this.byRequest(requestId);
        if (winner) return this.sameSnapshotRequest(winner, vm, input);
      }
      throw error;
    } finally {
      connection.release();
    }

    const row = await this.rowFor(agentId, operationId);
    // If this cannot be delivered, the operation stays queued and goes out when the agent reconnects.
    if (row) this.dispatch(requestFor(row), agentId);
    return this.require(operationId);
  }

  private async byRequest(requestId: string): Promise<OperationRow | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE op.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private sameSnapshotRequest(
    row: OperationRow,
    vm: VmIdentity,
    input: SnapshotInput,
  ): RegistrationOperation {
    if (
      row.mode !== 'snapshot' ||
      row.agent_id !== input.agentId ||
      row.emulator_type !== vm.emulatorType ||
      row.vm_name.toLowerCase() !== vm.vmName.toLowerCase() ||
      row.parent_version_id !== input.parentVersionId ||
      row.workspace_id !== (input.workspaceId ?? null)
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another operation.');
    }
    return toOperation(row, this.link.isOnline(row.agent_id));
  }

  private requireFreshDiscovery(input: CreateRegistrationRequest): void {
    const { agentId, emulatorType, vmName, discoveryOperationId } = input;
    if (!this.link.isOnline(agentId)) {
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
    if (!this.link.isRegistrationCapable(agentId)) {
      throw new ApiError(
        409,
        'agent_cannot_register',
        'This agent’s version cannot register VMs. Update it.',
      );
    }
    const stale = () =>
      new ApiError(
        409,
        'discovery_stale',
        'This discovery is out of date. Run discovery again, and choose the VM from the new report.',
      );
    const discovery = this.link.latestDiscovery(agentId);
    if (
      !discovery ||
      discovery.id !== discoveryOperationId ||
      discovery.status !== 'completed' ||
      !discovery.finishedAt ||
      Date.now() - discovery.finishedAt.getTime() > this.policy.discoveryMaxAgeMs ||
      discovery.connectionId !== this.link.activeConnectionId(agentId)
    ) {
      throw stale();
    }
    // Exactly as discovered: a different capitalization would be a different directory on some hosts.
    const found = discovery.vms.some(
      (vm) => vm.emulatorType === emulatorType && vm.vmName === vmName,
    );
    if (!found) throw stale();
  }

  async get(operationId: string): Promise<RegistrationOperation | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(`${OPERATION_QUERY} WHERE op.id = ?`, [
      operationId,
    ]);
    return rows[0] ? toOperation(rows[0], this.link.isOnline(rows[0].agent_id)) : null;
  }

  private async require(operationId: string): Promise<RegistrationOperation> {
    const operation = await this.get(operationId);
    if (!operation) throw new ApiError(404, 'registration_not_found', 'Registration not found');
    return operation;
  }

  async list(agentId?: string): Promise<RegistrationOperation[]> {
    const [rows] = agentId
      ? await this.pool.execute<OperationRow[]>(
          `${OPERATION_QUERY} WHERE op.agent_id = ? ORDER BY op.created_at DESC LIMIT 100`,
          [agentId],
        )
      : await this.pool.execute<OperationRow[]>(
          `${OPERATION_QUERY} ORDER BY op.created_at DESC LIMIT 100`,
        );
    return rows.map((row) => toOperation(row, this.link.isOnline(row.agent_id)));
  }

  /**
   * Allowed until the master exists. The commit holds the same row lock, so the two cannot overlap: a
   * cancellation either stops the commit, or finds that it is too late.
   */
  async cancel(operationId: string): Promise<RegistrationOperation> {
    const connection = await this.pool.getConnection();
    let tell: string | null;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT agent_id, state FROM registration_operations WHERE id = ? FOR UPDATE',
        [operationId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, 'registration_not_found', 'Registration not found');
      const state = row.state as RegistrationState;
      if (isRegistrationCommitted(state)) {
        throw new ApiError(
          409,
          'registration_committed',
          'The master is already registered, so this can no longer be cancelled.',
        );
      }
      if (isRegistrationTerminal(state)) {
        throw new ApiError(409, 'registration_finished', 'This registration has already ended.');
      }
      const online = this.link.isOnline(row.agent_id as string);
      // With no agent to wait for, or only a commit to stop, there is nothing to wait for.
      const immediate = state === 'queued' || state === 'committing' || !online;
      await connection.execute(
        `UPDATE registration_operations
         SET cancel_requested_at = COALESCE(cancel_requested_at, UTC_TIMESTAMP(3))${
           immediate
             ? `, state = 'cancelled', finished_at = UTC_TIMESTAMP(3), error_code = 'cancelled',
                error_message = 'Cancelled by an administrator.'`
             : ''
         }
         WHERE id = ?`,
        [operationId],
      );
      await connection.commit();
      tell = online ? (row.agent_id as string) : null;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (tell) {
      this.link.send(tell, { type: 'server.registration_cancel', payload: { operationId } });
    }
    await this.notifyWorkspace(operationId);
    return this.require(operationId);
  }

  /** Tries a commit again, from what the agent already reported. For when that first failed. */
  async reconcile(operationId: string): Promise<RegistrationOperation> {
    const before = await this.require(operationId);
    if (before.state === 'committing') {
      const ack = await this.commit(operationId);
      this.link.send(before.agentId, { type: 'server.registration_ack', payload: ack });
    } else if (!isRegistrationCommitted(before.state)) {
      throw new ApiError(
        409,
        'registration_not_reconcilable',
        'There is no verified archive waiting to be committed.',
      );
    }
    return this.require(operationId);
  }

  /**
   * Tries removing a local VM again, after a screenshot blocked its removal. This only asks: the agent
   * checks everything again, and the master was never in question. It holds the operation's row lock,
   * and the state goes back to `cleaning_local` so that the usual report ends it the usual way.
   */
  async retryCleanup(operationId: string): Promise<RegistrationOperation> {
    const before = await this.require(operationId);
    if (
      before.state !== 'partial_success' ||
      before.mode !== 'transfer' ||
      !isRetryableCleanup(before.error?.code)
    ) {
      throw new ApiError(
        409,
        'registration_not_retryable',
        'Only a transfer whose removal was blocked by a screenshot or a running VM can be retried.',
      );
    }
    if (!this.link.isOnline(before.agentId)) {
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
    // The agent checks again right before removing anything. This only spares it a request it refuses.
    const [sessions] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_sessions
       WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1`,
      [before.agentId, before.emulatorType, before.vmName],
    );
    if (sessions.length > 0) {
      throw new ApiError(409, 'vm_running', 'The VM is running on this agent. Stop it first.');
    }
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE registration_operations
         SET state = 'cleaning_local', local_copy = NULL, error_code = NULL, error_message = NULL,
             finished_at = NULL, progress_done_bytes = NULL, progress_total_bytes = NULL
         WHERE id = ? AND state = 'partial_success'
           AND error_code IN ('transfer_blocked_media', 'transfer_blocked_running')`,
        [operationId],
      );
      if (result.affectedRows === 0) {
        throw new ApiError(409, 'registration_not_retryable', 'This has already been retried.');
      }
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ApiError(
          409,
          'registration_in_progress',
          'A registration is already running on this agent.',
        );
      }
      throw error;
    }
    // If this is lost, the agent's next sync lists the operation as blocked, and it is sent again.
    this.link.send(before.agentId, {
      type: 'server.registration_retry_cleanup',
      payload: { operationId, versionId: before.versionId },
    });
    return this.require(operationId);
  }

  startHealthCheck(repositoryId: string, agentId: string): void {
    if (!this.link.isOnline(agentId)) {
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
    if (!this.link.isRegistrationCapable(agentId)) {
      throw new ApiError(
        409,
        'agent_cannot_register',
        'This agent’s version cannot use repositories. Update it.',
      );
    }
    const key = `${repositoryId}/${agentId}`;
    if (this.healthChecks.has(key)) return;
    const operationId = randomUUID();
    this.healthChecks.set(key, operationId);
    const timer = setTimeout(() => {
      this.finishHealthCheck(key);
      void recordHealthResult(
        this.pool,
        repositoryId,
        agentId,
        false,
        'repository_unreachable',
        'The agent did not answer in time.',
        null,
        null,
      ).catch((error: unknown) => {
        this.log.warn({ err: error }, 'Cannot record a health check');
      });
    }, this.policy.healthCheckTimeoutMs);
    timer.unref();
    this.healthTimers.set(key, timer);
    const sent = this.link.send(agentId, {
      type: 'server.repository_health_request',
      payload: { operationId, repositoryId },
    });
    if (!sent) {
      this.finishHealthCheck(key);
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
  }

  isHealthCheckRunning(repositoryId: string, agentId: string): boolean {
    return this.healthChecks.has(`${repositoryId}/${agentId}`);
  }

  private finishHealthCheck(key: string): void {
    this.healthChecks.delete(key);
    const timer = this.healthTimers.get(key);
    if (timer) clearTimeout(timer);
    this.healthTimers.delete(key);
  }

  // What an agent reports. The agent's identity comes from its connection, and nowhere else.

  private dispatch(request: RegistrationRequestPayload, agentId: string): boolean {
    return this.link.send(agentId, { type: 'server.registration_request', payload: request });
  }

  private ack(agentId: string, payload: RegistrationAckPayload): void {
    this.link.send(agentId, { type: 'server.registration_ack', payload });
  }

  private async rowFor(agentId: string, operationId: string): Promise<OperationRow | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE op.id = ? AND op.agent_id = ?`,
      [operationId, agentId],
    );
    return rows[0] ?? null;
  }

  /**
   * Compares what an agent has with what this server expects. Runs after each welcome, which is how a
   * restart on either side is recovered from.
   */
  async synced(agentId: string, payload: RegistrationSyncPayload): Promise<void> {
    const listed = new Map(payload.operations.map((entry) => [entry.operationId, entry.phase]));

    const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
    const [active] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE op.agent_id = ? AND op.state IN (${placeholders})`,
      [agentId, ...ACTIVE_STATES],
    );
    for (const row of active) {
      if (listed.has(row.id)) continue;
      if (row.state === 'queued') {
        this.dispatch(requestFor(row), agentId);
      } else if (row.state === 'cleaning_local') {
        await this.markPartial(row.id, 'agent_lost_operation', 'unknown');
      } else {
        await this.markFailed(row.id, 'agent_lost_operation');
      }
    }

    for (const [operationId, phase] of listed) {
      if (phase === 'media_blocked') {
        const row = await this.rowFor(agentId, operationId);
        if (row?.state === 'cleaning_local') {
          this.link.send(agentId, {
            type: 'server.registration_retry_cleanup',
            payload: { operationId, versionId: row.version_id },
          });
        }
        continue;
      }
      if (phase !== 'running' && phase !== 'publishing') continue;
      const row = await this.rowFor(agentId, operationId);
      // Finished here while the agent was away, or unknown here altogether: it should stop.
      if (!row || isRegistrationTerminal(row.state)) {
        this.link.send(agentId, { type: 'server.registration_cancel', payload: { operationId } });
      }
    }
  }

  async progress(agentId: string, payload: RegistrationProgressPayload): Promise<void> {
    const { operationId, stage, doneBytes, totalBytes } = payload;
    const allowed = STAGE_ALLOWED_FROM[stage];
    const placeholders = allowed.map(() => '?').join(', ');
    await this.pool.execute(
      `UPDATE registration_operations
       SET state = ?, progress_done_bytes = ?, progress_total_bytes = ?
       WHERE id = ? AND agent_id = ? AND state IN (${placeholders})`,
      [stage, doneBytes, totalBytes, operationId, agentId, ...allowed],
    );
  }

  async result(agentId: string, payload: RegistrationResultPayload): Promise<void> {
    const { operationId } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row) {
      // Not this agent's, or not known at all. Nothing is deleted on the word of an unknown operation.
      this.log.warn({ agentId, operationId }, 'A registration result for an unknown operation');
      this.ack(agentId, { operationId, outcome: 'rejected' });
      return;
    }

    if (isRegistrationCommitted(row.state)) {
      // The earlier acknowledgement was lost. Removal is allowed only while cleanup is what is left.
      this.ack(agentId, {
        operationId,
        outcome: 'committed',
        versionId: row.version_id,
        removeLocal: row.mode === 'transfer' && row.state === 'cleaning_local',
      });
      return;
    }
    if (isRegistrationTerminal(row.state)) {
      this.ack(agentId, {
        operationId,
        outcome: 'rejected',
        deletePublished: payload.versionId === row.version_id,
      });
      return;
    }

    // Only the identities this server issued count.
    if (payload.versionId !== row.version_id || payload.archiveKey !== row.archive_key) {
      this.log.error({ agentId, operationId }, 'A registration result with the wrong identities');
      await this.markFailed(operationId, 'invalid_result');
      this.ack(agentId, { operationId, outcome: 'rejected' });
      return;
    }

    await this.pool.execute(
      `UPDATE registration_operations
       SET state = 'committing', archive_size_bytes = ?, archive_sha256 = ?, manifest_version = ?,
           manifest_sha256 = ?, file_count = ?, total_uncompressed_bytes = ?
       WHERE id = ? AND agent_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled',
         'partial_success', 'cleaning_local')`,
      [
        payload.archiveSizeBytes,
        payload.archiveSha256,
        payload.manifestVersion,
        payload.manifestSha256,
        payload.fileCount,
        payload.totalUncompressedBytes,
        operationId,
        agentId,
      ],
    );
    // If this throws, nothing was committed and no answer is sent. The agent will report this again,
    // and the archive stays where it is, ready for that.
    this.ack(agentId, await this.commit(operationId));
  }

  /**
   * One transaction: the VM, its master, and what this agent's copy is, together with the operation's
   * new state. It either all exists afterwards, or none of it does.
   */
  private async commit(operationId: string): Promise<RegistrationAckPayload> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const outcome = await this.commitIn(connection, operationId);
      await connection.commit();
      if (outcome.outcome === 'rejected') await this.notifyWorkspace(operationId);
      return outcome;
    } catch (error) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        this.log.warn({ operationId }, 'A registration conflicted at commit');
        await this.markFailed(operationId, 'duplicate_registration');
        return { operationId, outcome: 'rejected', deletePublished: true };
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async commitIn(
    connection: PoolConnection,
    operationId: string,
  ): Promise<RegistrationAckPayload> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT op.*, a.revoked_at AS agent_revoked_at, ar.agent_id AS authorized, r.enabled
       FROM registration_operations AS op
       JOIN agents AS a ON a.id = op.agent_id
       JOIN repositories AS r ON r.id = op.repository_id
       LEFT JOIN agent_repositories AS ar
         ON ar.agent_id = op.agent_id AND ar.repository_id = op.repository_id
       WHERE op.id = ? FOR UPDATE`,
      [operationId],
    );
    const row = rows[0] as RowDataPacket | undefined;
    if (!row) return { operationId, outcome: 'rejected' };
    const committed: RegistrationAckPayload = {
      operationId,
      outcome: 'committed',
      versionId: row.version_id as string,
      removeLocal: row.mode === 'transfer',
    };
    if (row.state !== 'committing') {
      return isRegistrationCommitted(row.state as RegistrationState)
        ? committed
        : { operationId, outcome: 'rejected', deletePublished: true };
    }

    const refuse = async (state: 'failed' | 'cancelled', code: string, message: string) => {
      await connection.execute(
        `UPDATE registration_operations
         SET state = ?, error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [state, code, message, operationId],
      );
      const ack: RegistrationAckPayload = {
        operationId,
        outcome: 'rejected',
        deletePublished: true,
      };
      return ack;
    };
    if (row.cancel_requested_at) {
      return refuse('cancelled', 'cancelled', 'Cancelled by an administrator.');
    }
    if (row.agent_revoked_at) {
      return refuse('failed', 'agent_revoked', FAILURE_TEXT.agent_revoked as string);
    }
    if (!row.authorized || !row.enabled) {
      return refuse(
        'failed',
        'repository_not_authorized',
        FAILURE_TEXT.repository_not_authorized as string,
      );
    }

    if (row.mode === 'snapshot') {
      await this.commitSnapshotIn(connection, row);
      return committed;
    }

    await connection.execute(
      `INSERT INTO virtual_machines
         (emulator_type, vm_name, registered_by_user_id, discovered_by_agent_id)
       VALUES (?, ?, ?, ?)`,
      [row.emulator_type, row.vm_name, row.requested_by_user_id, row.agent_id],
    );
    await connection.execute(
      `INSERT INTO vm_versions
         (id, emulator_type, vm_name, kind, repository_id, archive_key, archive_sha256,
          archive_size_bytes, created_by_agent_id, created_by_user_id)
       VALUES (?, ?, ?, 'master', ?, ?, ?, ?, ?, ?)`,
      [
        row.version_id,
        row.emulator_type,
        row.vm_name,
        row.repository_id,
        row.archive_key,
        row.archive_sha256,
        row.archive_size_bytes,
        row.agent_id,
        row.requested_by_user_id,
      ],
    );
    await connection.execute(
      `INSERT INTO agent_vm_state
         (agent_id, emulator_type, vm_name, local_source_version_id, execution_state,
          content_status, last_verified_at, last_verified_sha256)
       VALUES (?, ?, ?, ?, 'idle', 'verified', UTC_TIMESTAMP(3), ?)`,
      [row.agent_id, row.emulator_type, row.vm_name, row.version_id, row.manifest_sha256],
    );
    await connection.execute(
      `UPDATE registration_operations
       SET state = 'cleaning_local', committed_at = UTC_TIMESTAMP(3),
           progress_done_bytes = NULL, progress_total_bytes = NULL
       WHERE id = ?`,
      [operationId],
    );
    return committed;
  }

  /**
   * A snapshot's commit: one immutable version under its parent, and the copy it was made from now being a
   * verified copy of it. The parent's foreign key keeps it in the same VM, and the version's trigger keeps
   * every earlier one as it was. A working copy's source moves instead; the persistent copy is untouched.
   */
  private async commitSnapshotIn(connection: PoolConnection, row: RowDataPacket): Promise<void> {
    await connection.execute(
      `INSERT INTO vm_versions
         (id, emulator_type, vm_name, kind, parent_version_id, snapshot_name, repository_id,
          archive_key, archive_sha256, archive_size_bytes, created_by_agent_id, created_by_user_id)
       VALUES (?, ?, ?, 'snapshot', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.version_id,
        row.emulator_type,
        row.vm_name,
        row.parent_version_id,
        row.snapshot_name,
        row.repository_id,
        row.archive_key,
        row.archive_sha256,
        row.archive_size_bytes,
        row.agent_id,
        row.requested_by_user_id,
      ],
    );
    if (row.workspace_id) {
      await connection.execute(
        `UPDATE vm_workspaces SET source_version_id = ?, may_have_changes = FALSE
         WHERE id = ? AND agent_id = ?`,
        [row.version_id, row.workspace_id, row.agent_id],
      );
    } else {
      await connection.execute(
        `INSERT INTO agent_vm_state
           (agent_id, emulator_type, vm_name, local_source_version_id, execution_state,
            content_status, last_verified_at, last_verified_sha256)
         VALUES (?, ?, ?, ?, 'idle', 'verified', UTC_TIMESTAMP(3), ?)
         ON DUPLICATE KEY UPDATE local_source_version_id = VALUES(local_source_version_id),
           execution_state = 'idle', content_status = 'verified',
           last_verified_at = VALUES(last_verified_at),
           last_verified_sha256 = VALUES(last_verified_sha256)`,
        [row.agent_id, row.emulator_type, row.vm_name, row.version_id, row.manifest_sha256],
      );
    }
    await connection.execute(
      `UPDATE registration_operations
       SET state = 'cleaning_local', committed_at = UTC_TIMESTAMP(3),
           progress_done_bytes = NULL, progress_total_bytes = NULL
       WHERE id = ?`,
      [row.id],
    );
  }

  async failed(agentId: string, payload: RegistrationErrorPayload): Promise<void> {
    const { operationId, code, message } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row || isRegistrationTerminal(row.state)) {
      this.ack(agentId, { operationId, outcome: 'closed' });
      return;
    }
    // An agent reports a failure only for work that did not publish, so these are not reachable from
    // a healthy agent, and nothing here may undo what they represent.
    if (row.state === 'committing' || row.state === 'cleaning_local') {
      this.log.warn({ agentId, operationId, code }, 'Ignored a failure after a verified result');
      return;
    }
    const cancelled = code === 'cancelled' || row.cancel_requested_at !== null;
    await this.pool.execute(
      `UPDATE registration_operations
       SET state = ?, error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3),
           local_copy = 'preserved'
       WHERE id = ? AND agent_id = ?`,
      [cancelled ? 'cancelled' : 'failed', code, message, operationId, agentId],
    );
    await this.notifyWorkspace(operationId);
    this.ack(agentId, { operationId, outcome: 'closed' });
  }

  async cleanedUp(agentId: string, payload: RegistrationCleanupPayload): Promise<void> {
    const { operationId, versionId, localCopy, code, message } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row || isRegistrationTerminal(row.state)) {
      this.ack(agentId, { operationId, outcome: 'closed' });
      return;
    }
    if (row.state !== 'cleaning_local' || row.version_id !== versionId) {
      this.log.warn({ agentId, operationId }, 'Ignored a cleanup report that does not fit');
      return;
    }
    // A copy or a snapshot cannot have removed anything, whatever a report says, and nothing here may
    // conclude otherwise about the local VM.
    if (row.mode !== 'transfer') {
      if (localCopy !== 'preserved') {
        this.log.error({ agentId, operationId }, 'A copy reported something other than preserved');
      }
      await this.pool.execute(
        `UPDATE registration_operations
         SET state = 'succeeded', local_copy = 'preserved', finished_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND state = 'cleaning_local'`,
        [operationId],
      );
      await this.notifyWorkspace(operationId);
      this.ack(agentId, { operationId, outcome: 'closed' });
      return;
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (localCopy === 'cleanup_failed') {
        await connection.execute(
          `UPDATE registration_operations
           SET state = 'partial_success', local_copy = 'cleanup_failed', error_code = ?,
               error_message = ?, finished_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [code ?? 'cleanup_incomplete', message ?? 'The local VM was not removed.', operationId],
        );
        await connection.execute(
          `UPDATE agent_vm_state SET execution_state = 'error', content_status = 'unverified',
             last_verified_at = NULL, last_verified_sha256 = NULL
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          [agentId, row.emulator_type, row.vm_name],
        );
      } else {
        await connection.execute(
          `UPDATE registration_operations
           SET state = 'succeeded', local_copy = ?, finished_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [localCopy, operationId],
        );
        if (localCopy === 'removed') {
          await connection.execute(
            `UPDATE agent_vm_state SET execution_state = 'absent', content_status = 'unverified',
               local_source_version_id = NULL, last_verified_at = NULL, last_verified_sha256 = NULL
             WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
            [agentId, row.emulator_type, row.vm_name],
          );
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    this.ack(agentId, { operationId, outcome: 'closed' });
  }

  async healthResult(agentId: string, payload: RepositoryHealthResultPayload): Promise<void> {
    const key = `${payload.repositoryId}/${agentId}`;
    // Only an answer to the question that was asked, by the agent that was asked.
    if (this.healthChecks.get(key) !== payload.operationId) {
      this.log.warn({ agentId }, 'Ignored an unexpected repository health result');
      return;
    }

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT config FROM repositories WHERE id = ?',
      [payload.repositoryId],
    );
    let { ok, code, message } = payload;
    if (ok && rows[0]) {
      // The agent's settings are local, so they may have drifted from this record. That only matters
      // if they point somewhere else, which is reported rather than trusted.
      const expected = (
        typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
      ) as { host: string; port: number; username: string; remoteRoot: string };
      const actual = payload.configuration;
      const matches =
        actual !== null &&
        actual.host === expected.host &&
        actual.port === expected.port &&
        actual.username === expected.username &&
        actual.remoteRoot === expected.remoteRoot;
      if (!matches) {
        ok = false;
        code = 'repository_config_mismatch';
        message =
          'The agent’s local settings for this repository differ from the ones recorded here.';
      }
    }
    await recordHealthResult(
      this.pool,
      payload.repositoryId,
      agentId,
      ok,
      code,
      message,
      payload.hostKeyFingerprint,
      payload.freeBytes,
    );
    // Only now: until the result is stored, a reader must not see "finished, with no result".
    this.finishHealthCheck(key);
  }

  /** Revocation ends everything the agent was doing, and never undoes a committed master. */
  async agentRevoked(agentId: string): Promise<void> {
    const [active] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, state FROM registration_operations
       WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
    for (const row of active) {
      if (row.state === 'cleaning_local') {
        await this.markPartial(row.id as string, 'agent_revoked', 'unknown');
      } else {
        await this.markFailed(row.id as string, 'agent_revoked');
      }
    }
  }

  private async markFailed(operationId: string, code: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE registration_operations
       SET state = 'failed', error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND active_marker = 1 AND state <> 'cleaning_local'`,
      [code, FAILURE_TEXT[code] ?? code, operationId],
    );
    await this.notifyWorkspace(operationId);
  }

  private async markPartial(
    operationId: string,
    code: string,
    localCopy: 'unknown',
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE registration_operations
       SET state = 'partial_success', local_copy = ?, error_code = ?, error_message = ?,
           finished_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND state = 'cleaning_local'`,
      [localCopy, code, FAILURE_TEXT[code] ?? code, operationId],
    );
    await this.notifyWorkspace(operationId);
  }
}
