import { randomUUID } from 'node:crypto';
import {
  CLONE_REFUSAL_TEXT,
  archiveObjectKey,
  vmNameKey,
  type CloneAgentOption,
  type CloneAgentRefusal,
  type CloneOptionsResponse,
  type CloneVersionRefusal,
  type CloneVmRequest,
  type RegistrationOperation,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { lockUsableVersion, NOT_DELETED } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import type { AgentLink, RegistrationCoordinator } from '../registration/coordinator.js';

const refuse = (code: CloneAgentRefusal | CloneVersionRefusal) =>
  new ApiError(409, code, CLONE_REFUSAL_TEXT[code]);

function isDuplicateEntry(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** Which unique key a duplicate entry hit, from MariaDB's message. */
function duplicateKey(error: unknown): string {
  return (error as { sqlMessage?: string }).sqlMessage ?? '';
}

interface SourceVersion {
  id: string;
  kind: 'master' | 'snapshot';
  vmName: string;
  repositoryId: string;
  repositoryEnabled: boolean;
  archiveKey: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  manifestSha256: string | null;
  snapshotName: string | null;
  title: string | null;
  deleted: boolean;
}

/** One agent's other work, of any kind. An agent runs one operation at a time. */
const AGENT_BUSY_SQL = `
  SELECT 1 FROM restore_operations WHERE agent_id = ? AND active_marker = 1
  UNION ALL SELECT 1 FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
  UNION ALL SELECT 1 FROM registration_operations WHERE agent_id = ? AND active_marker = 1
  UNION ALL SELECT 1 FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1
  UNION ALL SELECT 1 FROM virtualbox_operations WHERE agent_id = ? AND active_marker = 1`;

/**
 * Cloning one version of a VM into a new, independent VM (decision 0052). This only validates, reserves and
 * dispatches: the clone is a registration operation (`mode = 'clone'`) of the new VM, so the registration
 * coordinator receives the agent's reports and commits it, and its history, cancellation and recovery are those of
 * every registration. Nothing about the source is changed, locked for longer than the request, or deleted.
 */
export class CloneCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly link: AgentLink,
    private readonly registrations: RegistrationCoordinator,
    private readonly log: FastifyBaseLogger,
  ) {}

  private async sourceVersion(
    executor: Pool | PoolConnection,
    vm: VmIdentity,
    versionId: string,
    lock: boolean,
  ): Promise<SourceVersion> {
    // Scoped to the VM: a version of another VM is simply not found.
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT version.id, version.kind, version.vm_name, version.repository_id, version.archive_key,
              version.archive_sha256, version.archive_size_bytes, version.snapshot_name, version.title,
              r.enabled AS repository_enabled, reg.manifest_sha256,
              NOT (${NOT_DELETED('version')}) AS deleted
       FROM vm_versions AS version
       JOIN repositories AS r ON r.id = version.repository_id
       LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
       WHERE version.id = ? AND version.emulator_type = ? AND version.vm_name = ?${lock ? ' LOCK IN SHARE MODE' : ''}`,
      [versionId, vm.emulatorType, vm.vmName],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'version_not_found', 'Version not found');
    return {
      id: row.id as string,
      kind: row.kind as 'master' | 'snapshot',
      vmName: row.vm_name as string,
      repositoryId: row.repository_id as string,
      repositoryEnabled: Boolean(row.repository_enabled),
      archiveKey: row.archive_key as string,
      archiveSha256: row.archive_sha256 as string,
      archiveSizeBytes: Number(row.archive_size_bytes),
      manifestSha256: (row.manifest_sha256 as string | null) ?? null,
      snapshotName: (row.snapshot_name as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      deleted: Boolean(Number(row.deleted)),
    };
  }

  /** What the dialog shows: the source, whether it can be cloned, and which agents could do it. */
  async options(vm: VmIdentity, versionId: string): Promise<CloneOptionsResponse> {
    const source = await this.sourceVersion(this.pool, vm, versionId, false);
    let refusal: CloneVersionRefusal | null = null;
    if (source.deleted) refusal = 'version_deleted';
    else if (!source.repositoryEnabled) refusal = 'repository_disabled';
    else {
      const [remasters] = await this.pool.execute<RowDataPacket[]>(
        `SELECT 1 FROM vm_remaster_operations
         WHERE emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [vm.emulatorType, source.vmName],
      );
      if (remasters.length > 0) refusal = 'remaster_in_progress';
    }

    // Only agents that may use this version's repository: no other could ever read the archive.
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id, a.name, a.revoked_at,
              (SELECT COUNT(*) FROM restore_operations AS o WHERE o.agent_id = a.id AND o.active_marker = 1)
            + (SELECT COUNT(*) FROM vm_verifications AS o WHERE o.agent_id = a.id AND o.active_marker = 1)
            + (SELECT COUNT(*) FROM registration_operations AS o WHERE o.agent_id = a.id AND o.active_marker = 1)
            + (SELECT COUNT(*) FROM local_copy_removals AS o WHERE o.agent_id = a.id AND o.active_marker = 1)
            + (SELECT COUNT(*) FROM virtualbox_operations AS o WHERE o.agent_id = a.id AND o.active_marker = 1)
              AS busy
       FROM agent_repositories AS ar
       JOIN agents AS a ON a.id = ar.agent_id
       WHERE ar.repository_id = ? AND a.paired_at IS NOT NULL
       ORDER BY a.name, a.id`,
      [source.repositoryId],
    );
    const agents: CloneAgentOption[] = rows.map((row) => {
      const agentId = row.id as string;
      const online = this.link.isOnline(agentId);
      let reason: CloneAgentRefusal | null = null;
      if (row.revoked_at) reason = 'agent_revoked';
      else if (!online) reason = 'agent_offline';
      else if (!this.capable(agentId)) reason = 'agent_cannot_clone';
      else if (Number(row.busy) > 0) reason = 'agent_busy';
      return { agentId, agentName: row.name as string, online, eligible: reason === null, reason };
    });
    return {
      source: {
        emulatorType: vm.emulatorType,
        vmName: source.vmName,
        versionId: source.id,
        kind: source.kind,
        snapshotName: source.snapshotName,
        title: source.title,
        archiveSizeBytes: source.archiveSizeBytes,
      },
      refusal,
      agents,
    };
  }

  private capable(agentId: string): boolean {
    return (
      this.link.isRegistrationCapable(agentId) && (this.link.isCloneCapable?.(agentId) ?? false)
    );
  }

  /**
   * Validates, reserves the destination and dispatches. A repeated request ID returns the clone it already started,
   * whatever happened since; the same ID for anything else is refused.
   */
  async create(
    vm: VmIdentity,
    versionId: string,
    input: CloneVmRequest,
    userId: string,
  ): Promise<RegistrationOperation> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, vm, versionId, input);

    const { agentId } = input;
    const target = input.vmName;
    if (vmNameKey(target) === vmNameKey(vm.vmName)) {
      throw new ApiError(409, 'vm_already_registered', 'A clone needs a name of its own.');
    }
    if (!this.link.isOnline(agentId)) throw refuse('agent_offline');
    if (!this.capable(agentId)) throw refuse('agent_cannot_clone');

    const operationId = randomUUID();
    const newVersionId = randomUUID();
    const archiveKey = archiveObjectKey(
      { emulatorType: vm.emulatorType, vmName: target },
      newVersionId,
    );
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Before any row a deletion reads (decision 0041): either the deletion sees this clone, or this sees it.
      await lockUsableVersion(connection, versionId);
      const source = await this.sourceVersion(connection, vm, versionId, true);
      if (source.deleted) throw refuse('version_deleted');
      if (!source.repositoryEnabled) throw refuse('repository_disabled');

      // Shared, as a registration's: a restore or launch takes it exclusively, so none starts alongside.
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? LOCK IN SHARE MODE',
        [agentId],
      );
      if (!agents[0] || !agents[0].paired_at) {
        throw new ApiError(404, 'agent_not_found', 'Agent not found');
      }
      if (agents[0].revoked_at) throw refuse('agent_revoked');
      const [authorized] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM agent_repositories WHERE agent_id = ? AND repository_id = ?',
        [agentId, source.repositoryId],
      );
      if (authorized.length === 0) throw refuse('repository_not_authorized');
      const [busy] = await connection.execute<RowDataPacket[]>(AGENT_BUSY_SQL, [
        agentId,
        agentId,
        agentId,
        agentId,
        agentId,
      ]);
      if (busy.length > 0) throw refuse('agent_busy');

      // The destination: no VM of this emulator with this name, ignoring case as the collation does, and no
      // operation creating one. The unique active-VM key on the operation makes the second guarantee hold for
      // concurrent requests too, and the commit's insert makes a late collision fail rather than overwrite.
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT vm_name FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
        [vm.emulatorType, target],
      );
      if (existing[0]) {
        throw new ApiError(
          409,
          'vm_already_registered',
          `A ${vm.emulatorType} VM named ${existing[0].vm_name as string} already exists. Names ignore case.`,
        );
      }

      try {
        await connection.execute(
          `INSERT INTO registration_operations
             (id, agent_id, repository_id, requested_by_user_id, request_id, emulator_type, vm_name, mode,
              version_id, archive_key, clone_source_vm_name, clone_source_version_id,
              clone_source_archive_key, clone_source_archive_sha256, clone_source_archive_size_bytes,
              clone_source_manifest_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'clone', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            source.repositoryId,
            userId,
            input.requestId,
            vm.emulatorType,
            target,
            newVersionId,
            archiveKey,
            source.vmName,
            source.id,
            source.archiveKey,
            source.archiveSha256,
            source.archiveSizeBytes,
            source.manifestSha256,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          const key = duplicateKey(error);
          if (key.includes('uq_registration_request')) {
            throw new ApiError(409, 'request_id_reused', 'This request ID was already used.');
          }
          if (key.includes('uq_registration_active_vm')) {
            throw new ApiError(
              409,
              'registration_in_progress',
              'A VM with this name is being created right now.',
            );
          }
          throw refuse('agent_busy');
        }
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // Two identical requests at once: the loser finds the winner's clone.
      if (error instanceof ApiError && error.code === 'request_id_reused') {
        const winner = await this.byRequest(input.requestId);
        if (winner) return this.sameRequest(winner, vm, versionId, input);
      }
      throw error;
    } finally {
      connection.release();
    }

    this.log.info(
      { operationId, source: vm.vmName, versionId, target, agentId },
      'Clone requested',
    );
    // If this cannot be delivered, the operation stays queued and goes out when the agent reconnects.
    await this.registrations.dispatchOperation(agentId, operationId);
    return this.require(operationId);
  }

  private async byRequest(requestId: string): Promise<RowDataPacket | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, mode, agent_id, emulator_type, vm_name, clone_source_vm_name, clone_source_version_id
       FROM registration_operations WHERE request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private async sameRequest(
    row: RowDataPacket,
    vm: VmIdentity,
    versionId: string,
    input: CloneVmRequest,
  ): Promise<RegistrationOperation> {
    if (
      row.mode !== 'clone' ||
      row.agent_id !== input.agentId ||
      row.emulator_type !== vm.emulatorType ||
      row.clone_source_version_id !== versionId ||
      vmNameKey(row.clone_source_vm_name as string) !== vmNameKey(vm.vmName) ||
      vmNameKey(row.vm_name as string) !== vmNameKey(input.vmName)
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID was used for something else.');
    }
    return this.require(row.id as string);
  }

  private async require(operationId: string): Promise<RegistrationOperation> {
    const operation = await this.registrations.get(operationId);
    if (!operation) throw new Error(`Clone ${operationId} disappeared`);
    return operation;
  }
}
