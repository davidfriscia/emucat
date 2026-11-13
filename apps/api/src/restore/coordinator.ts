import { randomUUID } from 'node:crypto';
import {
  isRestoreCancellable,
  isRestoreTerminal,
  restoreRecovery,
  type CreateRestoreRequest,
  type RestoreAgentOption,
  type RestoreErrorPayload,
  type RestoreIneligibleReason,
  type RestoreOperation,
  type RestoreOptionsResponse,
  type RestoreProgressPayload,
  type RestoreRequestPayload,
  type RestoreResultPayload,
  type RestoreState,
  type RestoreSyncPayload,
  type ServerMessage,
  type RemoteSessionMode,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { removalIneligible } from '../cleanup/local-removals.js';
import { lockUsableVersion, NOT_DELETED } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';

/** What the coordinator needs from the hub, which owns the sockets. */
export interface RestoreLink {
  isOnline(agentId: string): boolean;
  /** What the agent said it can do on this connection. `null` until it has said, or if it never will. */
  restoreCapabilities(agentId: string): RestoreSyncPayload['capabilities'] | null;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

interface OperationRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  repository_id: string;
  repository_name: string;
  requested_by_display_name: string | null;
  emulator_type: RestoreOperation['emulatorType'];
  vm_name: string;
  version_id: string;
  workspace_id: string | null;
  workspace_purpose: string | null;
  replace_existing: number;
  replaced_version_id: string | null;
  discard_local_changes: number;
  state: RestoreState;
  archive_key: string;
  archive_sha256: string;
  archive_size_bytes: number | string;
  expected_manifest_sha256: string | null;
  expected_uncompressed_bytes: number | string | null;
  progress_done_bytes: number | string | null;
  progress_total_bytes: number | string | null;
  manifest_version: number | null;
  manifest_sha256: string | null;
  file_count: number | string | null;
  total_uncompressed_bytes: number | string | null;
  local_directory: string | null;
  cache_hit: number | null;
  downloaded_bytes: number | string | null;
  archive_cached: number | null;
  cache_total_bytes: number | string | null;
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const OPERATION_QUERY = `
  SELECT op.id, op.agent_id, a.name AS agent_name, op.repository_id, r.name AS repository_name,
         u.display_name AS requested_by_display_name,
         op.emulator_type, op.vm_name, op.version_id, op.workspace_id,
         w.purpose AS workspace_purpose, op.replace_existing, op.replaced_version_id,
         op.discard_local_changes, op.state,
         op.archive_key, op.archive_sha256, op.archive_size_bytes,
         op.expected_manifest_sha256, op.expected_uncompressed_bytes,
         op.progress_done_bytes, op.progress_total_bytes,
         op.manifest_version, op.manifest_sha256, op.file_count, op.total_uncompressed_bytes,
         op.local_directory, op.cache_hit, op.downloaded_bytes, op.archive_cached,
         op.cache_total_bytes, op.error_code, op.error_message, op.cancel_requested_at,
         op.finished_at, op.created_at, op.updated_at
  FROM restore_operations AS op
  JOIN agents AS a ON a.id = op.agent_id
  JOIN repositories AS r ON r.id = op.repository_id
  LEFT JOIN users AS u ON u.id = op.requested_by_user_id
  LEFT JOIN vm_workspaces AS w ON w.id = op.workspace_id`;

/** Stages only move forward, apart from going back to download again after a bad copy. */
const STAGE_ALLOWED_FROM: Record<RestoreProgressPayload['stage'], readonly RestoreState[]> = {
  validating: ['queued', 'validating'],
  downloading: ['queued', 'validating', 'downloading', 'verifying'],
  verifying: ['queued', 'validating', 'downloading', 'verifying'],
  extracting: ['queued', 'validating', 'downloading', 'verifying', 'extracting'],
  publishing_local: [
    'queued',
    'validating',
    'downloading',
    'verifying',
    'extracting',
    'publishing_local',
  ],
};

const toNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

const toBoolean = (value: number | null): boolean | null => (value === null ? null : value !== 0);

function toOperation(row: OperationRow, online: boolean): RestoreOperation {
  const hasManifest = row.manifest_sha256 !== null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentOnline: online,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    versionId: row.version_id,
    workspaceId: row.workspace_id,
    replacement: row.replace_existing
      ? {
          replacedVersionId: row.replaced_version_id,
          discardLocalChanges: row.discard_local_changes !== 0,
        }
      : null,
    state: row.state,
    archive: { sizeBytes: Number(row.archive_size_bytes), sha256: row.archive_sha256 },
    progress: {
      doneBytes: toNumber(row.progress_done_bytes),
      totalBytes: toNumber(row.progress_total_bytes),
    },
    verified: hasManifest
      ? {
          manifestVersion: Number(row.manifest_version),
          manifestSha256: row.manifest_sha256 as string,
          fileCount: Number(row.file_count),
          totalUncompressedBytes: Number(row.total_uncompressed_bytes),
          verifiedBy: 'agent',
        }
      : null,
    localDirectory: row.local_directory,
    cache: {
      hit: toBoolean(row.cache_hit),
      downloadedBytes: toNumber(row.downloaded_bytes),
      archiveCached: toBoolean(row.archive_cached),
      totalBytes: toNumber(row.cache_total_bytes),
    },
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    recovery: row.error_code ? restoreRecovery(row.error_code) : null,
    cancelRequested: row.cancel_requested_at !== null,
    requestedByDisplayName: row.requested_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

function requestFor(row: OperationRow): RestoreRequestPayload {
  return {
    operationId: row.id,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    repositoryId: row.repository_id,
    versionId: row.version_id,
    archiveKey: row.archive_key,
    archiveSizeBytes: Number(row.archive_size_bytes),
    archiveSha256: row.archive_sha256,
    manifestSha256: row.expected_manifest_sha256,
    expectedUncompressedBytes: toNumber(row.expected_uncompressed_bytes),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.workspace_purpose === 'remote_volatile' || row.workspace_purpose === 'remote_snapshot'
      ? { workspacePurpose: row.workspace_purpose }
      : {}),
    ...(row.replace_existing
      ? {
          replace: {
            expectedVersionId: row.replaced_version_id,
            discardLocalChanges: row.discard_local_changes !== 0,
          },
        }
      : {}),
  };
}

/** A restore that prepares a remote session's working copy, rather than the persistent local copy. */
export interface WorkspaceTarget {
  workspaceId: string;
  requestId: string;
  purpose: RemoteSessionMode;
}

const FAILURE_TEXT: Record<string, string> = {
  agent_revoked: 'The agent was revoked before this finished.',
  agent_lost_operation: 'The agent no longer knows about this operation.',
  invalid_result: 'The agent reported a result that does not belong to this operation.',
};

const INELIGIBLE_TEXT: Record<RestoreIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_restore: 'This agent’s version cannot restore VMs. Update it.',
  emulator_not_configured: 'This agent has no base path configured for this emulator.',
  repository_not_authorized: 'This agent is not associated with this VM’s repository.',
  repository_not_configured: 'This agent has no local configuration for this VM’s repository.',
  local_copy_exists:
    'This agent already holds a copy of this VM. Replace it explicitly, or run the version as a remote session.',
  no_local_copy: 'This agent holds no copy of this VM to replace. Restore it normally.',
  vm_running:
    'This VM is running on this agent, or may be. Stop it, or dismiss the session, first.',
  operation_in_progress: 'This agent is busy with another operation.',
};

interface EligibilityFacts {
  revoked: boolean;
  authorized: boolean;
  localState: string | null;
  /** An active session of this VM on this agent. */
  running: boolean;
  busy: boolean;
}

/**
 * Restoring on the server's side. It holds no state of its own: everything is in `restore_operations`,
 * so a restart loses nothing. Everything an agent reports is checked against that row. Reports repeat
 * until answered, so every handler is idempotent, as in decision 0015.
 */
export class RestoreCoordinator {
  /** Called after a working copy's restore has committed, so that it can be launched if asked. */
  onWorkspaceReady: ((workspaceId: string) => void) | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly link: RestoreLink,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Why an agent cannot restore this VM, or `null` if it can. */
  private ineligible(
    agentId: string,
    emulatorType: VmIdentity['emulatorType'],
    repositoryId: string,
    facts: EligibilityFacts,
    target: 'create' | 'replace' | 'workspace' = 'create',
  ): RestoreIneligibleReason | null {
    if (facts.revoked) return 'agent_revoked';
    if (!this.link.isOnline(agentId)) return 'agent_offline';
    const capabilities = this.link.restoreCapabilities(agentId);
    if (!capabilities) return 'agent_cannot_restore';
    // Only an agent that says it replaces safely is ever asked to (decision 0040).
    if (target === 'replace' && capabilities.replaceLocal !== true) return 'agent_cannot_restore';
    if (!capabilities.emulators.some((emulator) => emulator.emulatorType === emulatorType)) {
      return 'emulator_not_configured';
    }
    if (!facts.authorized) return 'repository_not_authorized';
    if (!capabilities.repositoryIds.includes(repositoryId)) return 'repository_not_configured';
    if (facts.running) return 'vm_running';
    // A working copy has its own directory: the persistent copy is neither in the way nor at risk. A
    // replacement needs one to replace, and an ordinary restore never touches one.
    const present = facts.localState !== null && facts.localState !== 'absent';
    if (target === 'create' && present) return 'local_copy_exists';
    if (target === 'replace' && !present) return 'no_local_copy';
    if (facts.busy) return 'operation_in_progress';
    return null;
  }

  // What an administrator sees and does.

  async options(vm: VmIdentity): Promise<RestoreOptionsResponse> {
    const [versions] = await this.pool.execute<RowDataPacket[]>(
      `SELECT version.id, version.kind, version.parent_version_id, version.snapshot_name,
              version.vm_name, version.repository_id, version.archive_size_bytes,
              version.archive_sha256, version.created_at, r.name AS repository_name,
              r.enabled AS repository_enabled,
              reg.manifest_sha256, reg.file_count, reg.total_uncompressed_bytes
       FROM vm_versions AS version
       JOIN repositories AS r ON r.id = version.repository_id
       LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
       WHERE version.emulator_type = ? AND version.vm_name = ? AND ${NOT_DELETED('version')}
       ORDER BY version.created_at, version.id`,
      [vm.emulatorType, vm.vmName],
    );
    const describe = (row: RowDataPacket) => ({
      versionId: row.id as string,
      repositoryId: row.repository_id as string,
      repositoryName: row.repository_name as string,
      repositoryEnabled: Boolean(row.repository_enabled),
      archiveSizeBytes: Number(row.archive_size_bytes),
      archiveSha256: row.archive_sha256 as string,
      createdAt: (row.created_at as Date).toISOString(),
      manifestSha256: (row.manifest_sha256 as string | null) ?? null,
      fileCount: toNumber(row.file_count as number | string | null),
      totalUncompressedBytes: toNumber(row.total_uncompressed_bytes as number | null),
    });
    const version = versions.find((row) => row.kind === 'master');
    if (!version) return { master: null, versions: [], agents: [] };
    const repositoryId = version.repository_id as string;
    const canonicalName = version.vm_name as string;

    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id, a.name, ar.agent_id AS authorized,
              s.local_source_version_id, s.execution_state, s.content_status, s.last_verified_at,
              (SELECT COUNT(*) FROM restore_operations AS op
                WHERE op.agent_id = a.id AND op.active_marker = 1) +
              (SELECT COUNT(*) FROM registration_operations AS reg
                WHERE reg.agent_id = a.id AND reg.active_marker = 1) +
              (SELECT COUNT(*) FROM vm_verifications AS v
                WHERE v.agent_id = a.id AND v.active_marker = 1) +
              (SELECT COUNT(*) FROM local_copy_removals AS removal
                WHERE removal.agent_id = a.id AND removal.active_marker = 1) AS active_operations,
              (SELECT COUNT(*) FROM vm_workspaces AS w
                WHERE w.agent_id = a.id AND w.state IN ('preparing', 'discarding'))
                AS workspace_operations,
              (SELECT COUNT(*) FROM vm_sessions AS session
                WHERE session.agent_id = a.id AND session.emulator_type = ? AND session.vm_name = ?
                  AND session.active_marker = 1) AS active_sessions
       FROM agents AS a
       LEFT JOIN agent_repositories AS ar ON ar.agent_id = a.id AND ar.repository_id = ?
       LEFT JOIN agent_vm_state AS s
         ON s.agent_id = a.id AND s.emulator_type = ? AND s.vm_name = ?
       WHERE a.revoked_at IS NULL AND a.paired_at IS NOT NULL
       ORDER BY a.name, a.id`,
      [vm.emulatorType, vm.vmName, repositoryId, vm.emulatorType, vm.vmName],
    );

    const agents: RestoreAgentOption[] = rows.map((row) => {
      const agentId = row.id as string;
      const state = (row.execution_state as string | null) ?? null;
      const reason = this.ineligible(agentId, vm.emulatorType, repositoryId, {
        revoked: false,
        authorized: row.authorized !== null,
        localState: state,
        running: Number(row.active_sessions) > 0,
        busy: Number(row.active_operations) > 0,
      });
      const replace = this.ineligible(
        agentId,
        vm.emulatorType,
        repositoryId,
        {
          revoked: false,
          authorized: row.authorized !== null,
          localState: state,
          running: Number(row.active_sessions) > 0,
          busy: Number(row.active_operations) > 0,
        },
        'replace',
      );
      const running = Number(row.active_sessions) > 0;
      const remove = removalIneligible(this.link, agentId, {
        revoked: false,
        localState: state,
        running,
        busy: Number(row.active_operations) + Number(row.workspace_operations) > 0,
      });
      const capabilities = this.link.restoreCapabilities(agentId);
      const base = capabilities?.emulators.find(
        (emulator) => emulator.emulatorType === vm.emulatorType,
      )?.basePath;
      return {
        agentId,
        agentName: row.name as string,
        online: this.link.isOnline(agentId),
        eligible: reason === null,
        ineligibleReason: reason,
        destination: base ? `${base}${base.includes('\\') ? '\\' : '/'}${canonicalName}` : null,
        local: {
          availability: state === null ? 'none' : state === 'absent' ? 'absent' : 'present',
          contentStatus:
            state === null || state === 'absent'
              ? null
              : (row.content_status as 'unverified' | 'verified' | 'modified'),
          sourceVersionId: (row.local_source_version_id as string | null) ?? null,
          lastVerifiedAt: (row.last_verified_at as Date | null)?.toISOString() ?? null,
        },
        replace: { eligible: replace === null, reason: replace },
        running,
        remove: { eligible: remove === null, reason: remove },
        cacheUsedBytes: capabilities?.cacheUsedBytes ?? null,
        cacheMaxBytes: capabilities?.cacheMaxBytes ?? null,
      };
    });

    return {
      master: describe(version),
      versions: versions.map((row) => ({
        ...describe(row),
        kind: row.kind as 'master' | 'snapshot',
        parentVersionId: (row.parent_version_id as string | null) ?? null,
        snapshotName: (row.snapshot_name as string | null) ?? null,
      })),
      agents,
    };
  }

  /**
   * Restores any version of a VM: the master or a snapshot, from anywhere in the tree. With a working
   * copy as the target, the same restore prepares a Remote Snapshot workspace instead, in one transaction
   * with its row, and the persistent copy is neither checked nor touched. See decision 0038.
   */
  async create(
    input: CreateRestoreRequest,
    userId: string,
    workspace: WorkspaceTarget | null = null,
  ): Promise<RestoreOperation> {
    const { agentId, emulatorType, vmName, versionId } = input;
    const replace = workspace ? null : (input.replace ?? null);
    const operationId = randomUUID();
    let request: RestoreRequestPayload;

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Registration takes this row's shared lock, so the two cannot start together on one agent.
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? FOR UPDATE',
        [agentId],
      );
      const agent = agents[0];
      if (!agent || !agent.paired_at) throw new ApiError(404, 'agent_not_found', 'Agent not found');

      // Scoped to the VM, so that a version of another VM cannot be named. The name that goes to the
      // agent is the one stored here, whatever capitalization the request used.
      const [versions] = await connection.execute<RowDataPacket[]>(
        `SELECT version.id, version.kind, version.vm_name, version.repository_id,
                version.archive_key, version.archive_sha256, version.archive_size_bytes,
                r.enabled AS repository_enabled, ar.agent_id AS authorized,
                reg.manifest_sha256, reg.total_uncompressed_bytes
         FROM vm_versions AS version
         JOIN repositories AS r ON r.id = version.repository_id
         LEFT JOIN agent_repositories AS ar
           ON ar.repository_id = version.repository_id AND ar.agent_id = ?
         LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
         WHERE version.id = ? AND version.emulator_type = ? AND version.vm_name = ?`,
        [agentId, versionId, emulatorType, vmName],
      );
      const version = versions[0];
      if (!version) throw new ApiError(404, 'version_not_found', 'Version not found');
      if (!version.repository_enabled) {
        throw new ApiError(409, 'repository_disabled', 'This repository is disabled.');
      }
      const canonicalName = version.vm_name as string;
      const repositoryId = version.repository_id as string;
      // Before any row a deletion reads is locked here (decision 0041).
      await lockUsableVersion(connection, versionId);

      const [states] = await connection.execute<RowDataPacket[]>(
        `SELECT execution_state, content_status, local_source_version_id FROM agent_vm_state
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
        [agentId, emulatorType, canonicalName],
      );
      const [registrations] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM registration_operations WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 1 FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1`,
        [agentId, agentId, agentId],
      );
      // Launch takes this row's lock too, so no session can begin while this is decided.
      const [sessions] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM vm_sessions
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [agentId, emulatorType, canonicalName],
      );
      const reason = this.ineligible(
        agentId,
        emulatorType,
        repositoryId,
        {
          revoked: agent.revoked_at !== null,
          authorized: version.authorized !== null,
          localState: (states[0]?.execution_state as string | undefined) ?? null,
          running: sessions.length > 0,
          busy: registrations.length > 0,
        },
        workspace ? 'workspace' : replace ? 'replace' : 'create',
      );
      if (reason) throw new ApiError(409, reason, INELIGIBLE_TEXT[reason]);
      if (replace) this.checkReplacement(replace, states[0]);

      if (workspace) {
        try {
          await connection.execute(
            `INSERT INTO vm_workspaces
               (id, agent_id, requested_by_user_id, request_id, emulator_type, vm_name, purpose,
                base_version_id, source_version_id, launch_on_ready)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
            [
              workspace.workspaceId,
              agentId,
              userId,
              workspace.requestId,
              emulatorType,
              canonicalName,
              workspace.purpose,
              versionId,
              versionId,
            ],
          );
        } catch (error) {
          if (isDuplicateEntry(error)) {
            throw new ApiError(
              409,
              'workspace_exists',
              'A remote session of this VM is still active on this agent. Wait for it to finish, or resolve it first.',
            );
          }
          throw error;
        }
      }

      request = {
        operationId,
        emulatorType,
        vmName: canonicalName,
        repositoryId,
        versionId,
        archiveKey: version.archive_key as string,
        archiveSizeBytes: Number(version.archive_size_bytes),
        archiveSha256: version.archive_sha256 as string,
        manifestSha256: (version.manifest_sha256 as string | null) ?? null,
        expectedUncompressedBytes: toNumber(version.total_uncompressed_bytes as number | null),
        ...(workspace
          ? { workspaceId: workspace.workspaceId, workspacePurpose: workspace.purpose }
          : {}),
        ...(replace
          ? {
              replace: {
                expectedVersionId: replace.expectedVersionId,
                discardLocalChanges: replace.discardLocalChanges,
              },
            }
          : {}),
      };
      try {
        await connection.execute(
          `INSERT INTO restore_operations
             (id, agent_id, repository_id, requested_by_user_id, emulator_type, vm_name, version_id,
              archive_key, archive_sha256, archive_size_bytes, expected_manifest_sha256,
              expected_uncompressed_bytes, workspace_id, replace_existing, replaced_version_id,
              discard_local_changes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            repositoryId,
            userId,
            emulatorType,
            canonicalName,
            versionId,
            request.archiveKey,
            request.archiveSha256,
            request.archiveSizeBytes,
            request.manifestSha256,
            request.expectedUncompressedBytes,
            workspace?.workspaceId ?? null,
            replace !== null,
            replace?.expectedVersionId ?? null,
            replace?.discardLocalChanges ?? false,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ApiError(409, 'operation_in_progress', INELIGIBLE_TEXT.operation_in_progress);
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
    this.dispatch(agentId, request);
    return this.require(operationId);
  }

  /**
   * What the server can check about a replacement before asking the agent, which checks it all again on
   * its own disk: that the page showed the copy recorded here, and that changes recorded here are
   * acknowledged as lost.
   */
  private checkReplacement(
    replace: NonNullable<CreateRestoreRequest['replace']>,
    state: RowDataPacket | undefined,
  ): void {
    const recorded = (state?.local_source_version_id as string | null | undefined) ?? null;
    if (recorded !== replace.expectedVersionId) {
      throw new ApiError(
        409,
        'local_copy_changed',
        'The local copy is no longer the one this page showed. Reload, and check what it is now.',
      );
    }
    if (state?.content_status === 'modified' && !replace.discardLocalChanges) {
      throw new ApiError(
        409,
        'local_copy_modified',
        'The local copy has changes that are in no version. Snapshot it first, or confirm that they are lost.',
      );
    }
  }

  async get(operationId: string): Promise<RestoreOperation | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(`${OPERATION_QUERY} WHERE op.id = ?`, [
      operationId,
    ]);
    return rows[0] ? toOperation(rows[0], this.link.isOnline(rows[0].agent_id)) : null;
  }

  private async require(operationId: string): Promise<RestoreOperation> {
    const operation = await this.get(operationId);
    if (!operation) throw new ApiError(404, 'restore_not_found', 'Restore not found');
    return operation;
  }

  async list(filter: {
    agentId?: string | undefined;
    emulatorType?: string | undefined;
    vmName?: string | undefined;
  }): Promise<RestoreOperation[]> {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.agentId) {
      conditions.push('op.agent_id = ?');
      values.push(filter.agentId);
    }
    if (filter.emulatorType) {
      conditions.push('op.emulator_type = ?');
      values.push(filter.emulatorType);
    }
    if (filter.vmName) {
      conditions.push('op.vm_name = ?');
      values.push(filter.vmName);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} ${where} ORDER BY op.created_at DESC LIMIT 100`,
      values,
    );
    return rows.map((row) => toOperation(row, this.link.isOnline(row.agent_id)));
  }

  /**
   * Allowed until publication begins. If the agent is connected it is asked, and the operation ends when
   * it reports back. If it is away, this takes effect at once, and it stops when it returns. A VM it
   * published in the meantime is still reported, and is never deleted.
   */
  async cancel(operationId: string): Promise<RestoreOperation> {
    const connection = await this.pool.getConnection();
    let tell: string | null;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT agent_id, state FROM restore_operations WHERE id = ? FOR UPDATE',
        [operationId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, 'restore_not_found', 'Restore not found');
      const state = row.state as RestoreState;
      if (isRestoreTerminal(state)) {
        throw new ApiError(409, 'restore_finished', 'This restore has already ended.');
      }
      if (!isRestoreCancellable(state)) {
        throw new ApiError(
          409,
          'restore_too_late',
          'The VM is already being published, so this can no longer be cancelled.',
        );
      }
      const online = this.link.isOnline(row.agent_id as string);
      const immediate = state === 'queued' || !online;
      await connection.execute(
        `UPDATE restore_operations
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
    await this.endWorkspaceOf(operationId);
    if (tell) this.link.send(tell, { type: 'server.restore_cancel', payload: { operationId } });
    return this.require(operationId);
  }

  // What an agent reports. The agent's identity comes from its connection, and nowhere else.

  private dispatch(agentId: string, request: RestoreRequestPayload): boolean {
    return this.link.send(agentId, { type: 'server.restore_request', payload: request });
  }

  private ack(agentId: string, operationId: string, outcome: 'closed' | 'rejected'): void {
    this.link.send(agentId, { type: 'server.restore_ack', payload: { operationId, outcome } });
  }

  private async rowFor(agentId: string, operationId: string): Promise<OperationRow | null> {
    const [rows] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE op.id = ? AND op.agent_id = ?`,
      [operationId, agentId],
    );
    return rows[0] ?? null;
  }

  /** Runs after each welcome, which is how a restart on either side is recovered from. */
  async synced(agentId: string, payload: RestoreSyncPayload): Promise<void> {
    const listed = new Map(payload.operations.map((entry) => [entry.operationId, entry.phase]));
    const [active] = await this.pool.execute<OperationRow[]>(
      `${OPERATION_QUERY} WHERE op.agent_id = ? AND op.active_marker = 1`,
      [agentId],
    );
    for (const row of active) {
      if (listed.has(row.id)) continue;
      if (row.state === 'queued') {
        this.dispatch(agentId, requestFor(row));
      } else if (row.state === 'committing') {
        // The agent has been answered. What it reported is here, and only recording it is left.
        await this.commit(row.id);
      } else {
        await this.markFailed(row.id, 'agent_lost_operation');
      }
    }

    for (const [operationId, phase] of listed) {
      if (phase !== 'running') continue;
      const row = await this.rowFor(agentId, operationId);
      // Finished here while the agent was away, or unknown here altogether: it should stop.
      if (!row || isRestoreTerminal(row.state)) {
        this.link.send(agentId, { type: 'server.restore_cancel', payload: { operationId } });
      }
    }

    await this.applyLocalCopies(agentId, payload.localCopies);
  }

  /**
   * What the agent can say about its copies now. "Verified" only ever comes from a restore or a
   * registration, so a new connection can lower that, and nothing here can raise it.
   */
  private async applyLocalCopies(
    agentId: string,
    copies: RestoreSyncPayload['localCopies'],
  ): Promise<void> {
    for (const copy of copies) {
      const identity = [agentId, copy.emulatorType, copy.vmName, copy.versionId];
      if (copy.status === 'absent') {
        await this.pool.execute(
          `UPDATE agent_vm_state
           SET execution_state = 'absent', content_status = 'unverified', last_verified_at = NULL,
               last_verified_sha256 = NULL
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND local_source_version_id = ?`,
          identity,
        );
      } else if (copy.status === 'modified') {
        await this.pool.execute(
          `UPDATE agent_vm_state SET content_status = 'modified'
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND local_source_version_id = ?
             AND execution_state <> 'absent'`,
          identity,
        );
      } else {
        await this.pool.execute(
          `UPDATE agent_vm_state SET content_status = 'unverified'
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND local_source_version_id = ?
             AND execution_state <> 'absent' AND content_status = 'verified'`,
          identity,
        );
      }
    }
  }

  /**
   * A completed discovery says what is on the disk. A copy that is gone is recorded as absent, and one
   * that came back is recorded as unverified, since nothing has checked what it holds. Emulators whose
   * scan was cut short or could not run say nothing, so nothing is concluded from them.
   */
  async discovered(
    agentId: string,
    report: {
      emulators: readonly { emulatorType: string; status: string; truncated: boolean }[];
      vms: readonly { emulatorType: string; vmName: string }[];
    },
  ): Promise<void> {
    const complete = report.emulators
      .filter((emulator) => emulator.status === 'ok' && !emulator.truncated)
      .map((emulator) => emulator.emulatorType);
    if (complete.length === 0) return;
    const placeholders = complete.map(() => '?').join(', ');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT emulator_type, vm_name, execution_state FROM agent_vm_state
       WHERE agent_id = ? AND emulator_type IN (${placeholders})`,
      [agentId, ...complete],
    );
    const lower = (name: string) => name.toLowerCase();
    const present = new Set(report.vms.map((vm) => `${vm.emulatorType}/${lower(vm.vmName)}`));
    for (const row of rows) {
      const found = present.has(`${row.emulator_type as string}/${lower(row.vm_name as string)}`);
      const identity = [agentId, row.emulator_type as string, row.vm_name as string];
      if (!found && row.execution_state !== 'absent') {
        await this.pool.execute(
          `UPDATE agent_vm_state
           SET execution_state = 'absent', content_status = 'unverified', last_verified_at = NULL,
               last_verified_sha256 = NULL
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          identity,
        );
      } else if (found && row.execution_state === 'absent') {
        await this.pool.execute(
          `UPDATE agent_vm_state SET execution_state = 'unknown', content_status = 'unverified'
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          identity,
        );
      }
    }
  }

  async progress(agentId: string, payload: RestoreProgressPayload): Promise<void> {
    const { operationId, stage, doneBytes, totalBytes, cacheHit } = payload;
    const allowed = STAGE_ALLOWED_FROM[stage];
    const placeholders = allowed.map(() => '?').join(', ');
    await this.pool.execute(
      `UPDATE restore_operations
       SET state = ?, progress_done_bytes = ?, progress_total_bytes = ?,
           cache_hit = COALESCE(?, cache_hit)
       WHERE id = ? AND agent_id = ? AND state IN (${placeholders})`,
      [stage, doneBytes, totalBytes, cacheHit, operationId, agentId, ...allowed],
    );
  }

  async result(agentId: string, payload: RestoreResultPayload): Promise<void> {
    const { operationId } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row) {
      // Not this agent's, or not known at all. The agent keeps its directory either way.
      this.log.warn({ agentId, operationId }, 'A restore result for an unknown operation');
      this.ack(agentId, operationId, 'rejected');
      return;
    }
    if (row.state === 'succeeded' || row.state === 'partial_success') {
      this.ack(agentId, operationId, 'closed');
      return;
    }
    // Only what this operation was issued for counts. The agent keeps its directory whatever is said.
    const expectedManifest = row.expected_manifest_sha256;
    if (
      payload.versionId !== row.version_id ||
      payload.archiveSha256 !== row.archive_sha256 ||
      payload.archiveSizeBytes !== Number(row.archive_size_bytes) ||
      (expectedManifest !== null && payload.manifestSha256 !== expectedManifest)
    ) {
      this.log.error({ agentId, operationId }, 'A restore result with the wrong identities');
      await this.markFailed(operationId, 'invalid_result');
      this.ack(agentId, operationId, 'rejected');
      return;
    }

    await this.pool.execute(
      `UPDATE restore_operations
       SET state = IF(active_marker = 1, 'committing', state), manifest_version = ?,
           manifest_sha256 = ?, file_count = ?, total_uncompressed_bytes = ?, local_directory = ?,
           cache_hit = ?, downloaded_bytes = ?, archive_cached = ?, cache_total_bytes = ?,
           progress_done_bytes = NULL, progress_total_bytes = NULL
       WHERE id = ? AND agent_id = ?`,
      [
        payload.manifestVersion,
        payload.manifestSha256,
        payload.fileCount,
        payload.totalUncompressedBytes,
        payload.localDirectory,
        payload.cache.hit,
        payload.cache.downloadedBytes,
        payload.cache.archiveCached,
        payload.cache.totalBytes,
        operationId,
        agentId,
      ],
    );
    // If this throws, no answer is sent, the agent reports again, and the directory stays where it is.
    await this.commit(operationId);
    this.ack(agentId, operationId, 'closed');
  }

  /**
   * One transaction: what this agent's copy is, together with the operation's new state. A verified
   * directory exists at this point whatever has been decided here, so a cancellation or a failure that
   * got ahead of this report becomes a partial success, which tells the truth about the disk.
   */
  private async commit(operationId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let readyWorkspace: string | null;
    try {
      await connection.beginTransaction();
      readyWorkspace = await this.commitIn(connection, operationId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (readyWorkspace) this.onWorkspaceReady?.(readyWorkspace);
  }

  /** Returns the working copy that became ready, if this restore prepared one. */
  private async commitIn(connection: PoolConnection, operationId: string): Promise<string | null> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT agent_id, emulator_type, vm_name, version_id, workspace_id, state, manifest_sha256,
              local_directory, cancel_requested_at
       FROM restore_operations WHERE id = ? FOR UPDATE`,
      [operationId],
    );
    const row = rows[0];
    if (!row || !row.manifest_sha256) return null;
    const state = row.state as RestoreState;
    if (state === 'succeeded' || state === 'partial_success') return null;

    const workspaceId = (row.workspace_id as string | null) ?? null;
    if (workspaceId) {
      // The directory exists whatever was decided meanwhile, so the working copy is ready: discarding
      // it is an administrator's decision, as for any other.
      await connection.execute(
        `UPDATE vm_workspaces
         SET state = 'ready', local_directory = ?, finished_at = NULL, error_code = NULL,
             error_message = NULL
         WHERE id = ? AND state IN ('preparing', 'failed')`,
        [row.local_directory, workspaceId],
      );
    } else
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
    if (row.cancel_requested_at || isRestoreTerminal(state)) {
      await connection.execute(
        `UPDATE restore_operations
         SET state = 'partial_success', error_code = 'restore_cancel_too_late',
             error_message = 'The VM was published before the operation could be stopped.',
             finished_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [operationId],
      );
    } else {
      await connection.execute(
        `UPDATE restore_operations
         SET state = 'succeeded', error_code = NULL, error_message = NULL,
             finished_at = UTC_TIMESTAMP(3)
         WHERE id = ?`,
        [operationId],
      );
    }
    return workspaceId;
  }

  /** A restore that ended without publishing leaves its working copy with nothing on disk. */
  private async endWorkspaceOf(operationId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_workspaces AS w
       JOIN restore_operations AS op ON op.workspace_id = w.id
       SET w.state = 'failed', w.finished_at = UTC_TIMESTAMP(3), w.error_code = op.error_code,
           w.error_message = op.error_message
       WHERE op.id = ? AND op.state IN ('failed', 'cancelled') AND w.state = 'preparing'`,
      [operationId],
    );
  }

  async failed(agentId: string, payload: RestoreErrorPayload): Promise<void> {
    const { operationId, code, message } = payload;
    const row = await this.rowFor(agentId, operationId);
    if (!row || isRestoreTerminal(row.state)) {
      this.ack(agentId, operationId, 'closed');
      return;
    }
    // A failure after a verified result is not reachable from a healthy agent, and cannot undo it.
    if (row.state === 'committing') {
      this.log.warn({ agentId, operationId, code }, 'Ignored a failure after a verified result');
      return;
    }
    const cancelled = code === 'cancelled' || row.cancel_requested_at !== null;
    await this.pool.execute(
      `UPDATE restore_operations
       SET state = ?, error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND agent_id = ?`,
      [cancelled ? 'cancelled' : 'failed', code, message, operationId, agentId],
    );
    await this.endWorkspaceOf(operationId);
    this.ack(agentId, operationId, 'closed');
  }

  /** Revocation ends everything the agent was doing, and says nothing about what is on its disk. */
  async agentRevoked(agentId: string): Promise<void> {
    const [active] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, state FROM restore_operations WHERE agent_id = ? AND active_marker = 1',
      [agentId],
    );
    for (const row of active) {
      await this.markFailed(row.id as string, 'agent_revoked');
    }
  }

  private async markFailed(operationId: string, code: string): Promise<void> {
    await this.pool.execute(
      `UPDATE restore_operations
       SET state = 'failed', error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND active_marker = 1`,
      [code, FAILURE_TEXT[code] ?? code, operationId],
    );
    await this.endWorkspaceOf(operationId);
  }
}
