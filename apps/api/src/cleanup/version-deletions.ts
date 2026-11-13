import { randomUUID } from 'node:crypto';
import {
  SNAPSHOT_DELETE_REFUSAL_TEXT,
  VERSION_DELETED_TEXT,
  type ArchiveDeletePayload,
  type ArchiveDeleteResultPayload,
  type DeleteSnapshotRequest,
  type RestoreSyncPayload,
  type SnapshotDeleteRefusal,
  type VersionDeletability,
  type VersionDeletion,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import type { CleanupLink } from './local-removals.js';

/** "Record has changed since last read": a locking read found a row newer than the read view. */
const ER_CHECKREAD = 1020;

/**
 * Every creator of a new reference to a version calls this inside its transaction, before inserting
 * anything, and before locking any other row that a deletion reads (decision 0041). Either it locks
 * first, and the deletion then sees its reference and refuses, or the deletion locked first, and this sees
 * the tombstone and refuses.
 */
export async function lockUsableVersion(
  connection: PoolConnection,
  versionId: string,
): Promise<void> {
  try {
    await connection.execute('SELECT id FROM vm_versions WHERE id = ? LOCK IN SHARE MODE', [
      versionId,
    ]);
    const [tombstones] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_version_deletions WHERE version_id = ? LOCK IN SHARE MODE',
      [versionId],
    );
    if (tombstones.length > 0) throw new ApiError(409, 'version_deleted', VERSION_DELETED_TEXT);
  } catch (error) {
    // With snapshot isolation (MariaDB 11.6 and later), a locking read of a row committed after this
    // transaction's first read is refused rather than returned. Versions never change, so the row is
    // a tombstone that won the race: the version is deleted.
    if ((error as { errno?: number }).errno === ER_CHECKREAD) {
      throw new ApiError(409, 'version_deleted', VERSION_DELETED_TEXT);
    }
    throw error;
  }
}

/** `NOT EXISTS` clause leaving out versions that are deleted or being deleted. */
export const NOT_DELETED = (alias: string) =>
  `NOT EXISTS (SELECT 1 FROM vm_version_deletions AS deletion WHERE deletion.version_id = ${alias}.id)`;

interface DeletionRow extends RowDataPacket {
  version_id: string;
  emulator_type: VersionDeletion['emulatorType'];
  vm_name: string;
  snapshot_name: string | null;
  parent_version_id: string | null;
  repository_id: string;
  repository_name: string;
  archive_key: string;
  archive_sha256: string;
  archive_size_bytes: number | string;
  version_created_at: Date;
  state: VersionDeletion['state'];
  archive_outcome: VersionDeletion['archiveOutcome'];
  attempt_id: string | null;
  agent_id: string | null;
  attempts: number;
  next_retry_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  requested_by_display_name: string | null;
  requested_at: Date;
  completed_at: Date | null;
}

const DELETION_QUERY = `
  SELECT d.version_id, d.emulator_type, d.vm_name, version.snapshot_name, version.parent_version_id,
         d.repository_id, r.name AS repository_name, d.archive_key, d.archive_sha256,
         d.archive_size_bytes, version.created_at AS version_created_at, d.state, d.archive_outcome,
         d.attempt_id, d.agent_id, d.attempts, d.next_retry_at, d.error_code, d.error_message,
         u.display_name AS requested_by_display_name, d.requested_at, d.completed_at
  FROM vm_version_deletions AS d
  JOIN vm_versions AS version ON version.id = d.version_id
  JOIN repositories AS r ON r.id = d.repository_id
  LEFT JOIN users AS u ON u.id = d.requested_by_user_id`;

function toDeletion(row: DeletionRow): VersionDeletion {
  return {
    versionId: row.version_id,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    snapshotName: row.snapshot_name,
    parentVersionId: row.parent_version_id,
    repositoryName: row.repository_name,
    archiveSizeBytes: Number(row.archive_size_bytes),
    archiveSha256: row.archive_sha256,
    versionCreatedAt: row.version_created_at.toISOString(),
    state: row.state,
    archiveOutcome: row.archive_outcome,
    attempts: Number(row.attempts),
    nextRetryAt: row.state === 'deleting' ? (row.next_retry_at?.toISOString() ?? null) : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    requestedByDisplayName: row.requested_by_display_name,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

const refuse = (reason: SnapshotDeleteRefusal) =>
  new ApiError(409, reason, SNAPSHOT_DELETE_REFUSAL_TEXT[reason]);

export interface VersionDeletionOptions {
  /** The first retry's delay. Each later one doubles, up to `retryMaxMs`. */
  retryBaseMs: number;
  retryMaxMs: number;
  /** How often due retries are looked for. */
  sweepIntervalMs: number;
}

const DEFAULT_OPTIONS: VersionDeletionOptions = {
  retryBaseMs: 30_000,
  retryMaxMs: 60 * 60_000,
  sweepIntervalMs: 15_000,
};

/**
 * Permanently deleting a leaf snapshot (decision 0041). The tombstone is recorded first, in one transaction
 * that checks every rule under the version's exclusive lock; from then on the version is unusable. The
 * archive is then deleted by an agent configured for its repository, since the server holds no repository
 * credentials (decision 0012), and the tombstone becomes `deleted` once the agent has looked and found
 * nothing at the key. Nothing is cascaded, reparented or collected.
 */
export class VersionDeletionCoordinator {
  private readonly options: VersionDeletionOptions;
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly link: CleanupLink,
    private readonly log: FastifyBaseLogger,
    options: Partial<VersionDeletionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.sweepIntervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sweeping;
  }

  /** An online agent that can delete from this repository, or `null`. */
  async deleterFor(repositoryId: string): Promise<string | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id FROM agents AS a
       JOIN agent_repositories AS ar ON ar.agent_id = a.id AND ar.repository_id = ?
       WHERE a.revoked_at IS NULL AND a.paired_at IS NOT NULL
       ORDER BY a.name, a.id`,
      [repositoryId],
    );
    for (const row of rows) {
      const agentId = row.id as string;
      const capabilities = this.link.restoreCapabilities(agentId);
      if (
        this.link.isOnline(agentId) &&
        capabilities?.deleteArchives === true &&
        capabilities.repositoryIds.includes(repositoryId)
      ) {
        return agentId;
      }
    }
    return null;
  }

  /**
   * Why a version cannot be deleted now, or `null`. Inside the deletion's transaction every read locks;
   * outside it, this only informs the interface.
   */
  private async refusal(
    executor: Pool | PoolConnection,
    version: RowDataPacket,
    lock: boolean,
  ): Promise<SnapshotDeleteRefusal | null> {
    if (version.kind !== 'snapshot') return 'master_cannot_be_deleted';
    const id = version.id as string;
    const shared = lock ? ' LOCK IN SHARE MODE' : '';
    // A child being deleted still counts: only a deleted one does not.
    const [children] = await executor.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_versions AS child
       LEFT JOIN vm_version_deletions AS d ON d.version_id = child.id
       WHERE child.parent_version_id = ? AND (d.state IS NULL OR d.state <> 'deleted')
       LIMIT 1${shared}`,
      [id],
    );
    if (children.length > 0) return 'snapshot_has_descendants';
    // One locking read per table: a lock after a UNION would not cover every part of it.
    const uses: [string, string[]][] = [
      [
        'restore_operations WHERE active_marker = 1 AND (version_id = ? OR replaced_version_id = ?)',
        [id, id],
      ],
      ['registration_operations WHERE active_marker = 1 AND parent_version_id = ?', [id]],
      [
        'vm_workspaces WHERE active_marker = 1 AND (base_version_id = ? OR source_version_id = ?)',
        [id, id],
      ],
      ['vm_sessions WHERE active_marker = 1 AND source_version_id = ?', [id]],
      ['vm_verifications WHERE active_marker = 1 AND version_id = ?', [id]],
      ['local_copy_removals WHERE active_marker = 1 AND expected_version_id = ?', [id]],
    ];
    for (const [from, values] of uses) {
      const [rows] = await executor.execute<RowDataPacket[]>(
        `SELECT 1 FROM ${from} LIMIT 1${shared}`,
        values,
      );
      if (rows.length > 0) return 'snapshot_in_use';
    }
    // A revoked agent can neither remove nor replace its copy, so it does not hold the snapshot back.
    // Only `agent_vm_state` is locked, never `agents`: a restore or launch holds its agent's row
    // exclusively while it waits for this version's lock, so locking it here would deadlock.
    const [installed] = await executor.execute<RowDataPacket[]>(
      `SELECT agent_id FROM agent_vm_state
       WHERE local_source_version_id = ? AND execution_state <> 'absent'${shared}`,
      [id],
    );
    if (installed.length > 0) {
      const ids = installed.map((row) => row.agent_id as string);
      const [holders] = await this.pool.execute<RowDataPacket[]>(
        `SELECT 1 FROM agents WHERE revoked_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})
         LIMIT 1`,
        ids,
      );
      if (holders.length > 0) return 'snapshot_installed';
    }
    if (!version.repository_enabled) return 'repository_unavailable';
    if ((await this.deleterFor(version.repository_id as string)) === null) {
      return 'repository_unavailable';
    }
    return null;
  }

  /** Whether each listed version could be deleted now, for the version tree. */
  async deletability(vm: VmIdentity): Promise<Map<string, VersionDeletability>> {
    const [versions] = await this.pool.execute<RowDataPacket[]>(
      `SELECT version.id, version.kind, version.repository_id, r.enabled AS repository_enabled
       FROM vm_versions AS version
       JOIN repositories AS r ON r.id = version.repository_id
       WHERE version.emulator_type = ? AND version.vm_name = ? AND ${NOT_DELETED('version')}`,
      [vm.emulatorType, vm.vmName],
    );
    const result = new Map<string, VersionDeletability>();
    for (const version of versions) {
      const reason = await this.refusal(this.pool, version, false);
      result.set(version.id as string, { eligible: reason === null, reason });
    }
    return result;
  }

  async create(
    vm: VmIdentity,
    input: DeleteSnapshotRequest,
    userId: string,
  ): Promise<VersionDeletion> {
    const { versionId, requestId } = input;
    const repeated = await this.byRequest(requestId);
    if (repeated) return this.sameRequest(repeated, vm, versionId);

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // First, and exclusively: every creator of a reference to this version takes it shared first.
      const [versions] = await connection.execute<RowDataPacket[]>(
        `SELECT version.id, version.kind, version.emulator_type, version.vm_name,
                version.repository_id, version.archive_key, version.archive_sha256,
                version.archive_size_bytes
         FROM vm_versions AS version
         WHERE version.id = ? AND version.emulator_type = ? AND version.vm_name = ?
         FOR UPDATE`,
        [versionId, vm.emulatorType, vm.vmName],
      );
      const version = versions[0];
      if (!version) throw new ApiError(404, 'version_not_found', 'Version not found');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM vm_version_deletions WHERE version_id = ? FOR UPDATE',
        [versionId],
      );
      if (existing.length > 0) {
        // Asked again: the same tombstone.
        await connection.commit();
        return this.require(versionId);
      }
      const [repositories] = await connection.execute<RowDataPacket[]>(
        'SELECT enabled FROM repositories WHERE id = ? LOCK IN SHARE MODE',
        [version.repository_id],
      );
      const reason = await this.refusal(
        connection,
        { ...version, repository_enabled: repositories[0]?.enabled },
        true,
      );
      if (reason) throw refuse(reason);
      await connection.execute(
        `INSERT INTO vm_version_deletions
           (version_id, emulator_type, vm_name, request_id, requested_by_user_id, repository_id,
            archive_key, archive_sha256, archive_size_bytes, next_retry_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))`,
        [
          versionId,
          version.emulator_type,
          version.vm_name,
          requestId,
          userId,
          version.repository_id,
          version.archive_key,
          version.archive_sha256,
          version.archive_size_bytes,
          // The first attempt is this request's own, right after the commit; the sweep only takes over
          // if that one never happens.
          this.options.retryBaseMs * 1000,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        const winner = await this.byRequest(requestId);
        if (winner) return this.sameRequest(winner, vm, versionId);
      }
      throw error;
    } finally {
      connection.release();
    }
    this.log.info({ versionId, vmName: vm.vmName }, 'Snapshot deletion recorded');
    await this.attempt(versionId);
    return this.require(versionId);
  }

  private async byRequest(requestId: string): Promise<DeletionRow | null> {
    const [rows] = await this.pool.execute<DeletionRow[]>(
      `${DELETION_QUERY} WHERE d.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private sameRequest(row: DeletionRow, vm: VmIdentity, versionId: string): VersionDeletion {
    if (
      row.version_id !== versionId ||
      row.emulator_type !== vm.emulatorType ||
      row.vm_name.toLowerCase() !== vm.vmName.toLowerCase()
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another operation.');
    }
    return toDeletion(row);
  }

  async get(versionId: string): Promise<VersionDeletion | null> {
    const [rows] = await this.pool.execute<DeletionRow[]>(
      `${DELETION_QUERY} WHERE d.version_id = ?`,
      [versionId],
    );
    return rows[0] ? toDeletion(rows[0]) : null;
  }

  private async require(versionId: string): Promise<VersionDeletion> {
    const deletion = await this.get(versionId);
    if (!deletion) throw new ApiError(404, 'deletion_not_found', 'Deletion not found');
    return deletion;
  }

  async list(vm: VmIdentity): Promise<VersionDeletion[]> {
    const [rows] = await this.pool.execute<DeletionRow[]>(
      `${DELETION_QUERY} WHERE d.emulator_type = ? AND d.vm_name = ?
       ORDER BY d.requested_at DESC, d.version_id LIMIT 100`,
      [vm.emulatorType, vm.vmName],
    );
    return rows.map(toDeletion);
  }

  /** An administrator's retry: sent now, rather than when the delay ends. */
  async retry(vm: VmIdentity, versionId: string): Promise<VersionDeletion> {
    const deletion = await this.get(versionId);
    if (
      !deletion ||
      deletion.emulatorType !== vm.emulatorType ||
      deletion.vmName.toLowerCase() !== vm.vmName.toLowerCase()
    ) {
      throw new ApiError(404, 'deletion_not_found', 'Deletion not found');
    }
    if (deletion.state === 'deleted') {
      throw new ApiError(409, 'deletion_finished', 'This snapshot has already been deleted.');
    }
    if (!(await this.attempt(versionId))) throw refuse('repository_unavailable');
    return this.require(versionId);
  }

  private delay(attempts: number): number {
    return Math.min(
      this.options.retryBaseMs * 2 ** Math.max(0, attempts - 1),
      this.options.retryMaxMs,
    );
  }

  /**
   * Sends one attempt to an eligible agent, with a new attempt ID, and schedules the next one in case
   * no answer comes. Returns whether one was sent.
   */
  private async attempt(versionId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<DeletionRow[]>(
      `${DELETION_QUERY} WHERE d.version_id = ? AND d.state = 'deleting'`,
      [versionId],
    );
    const row = rows[0];
    if (!row) return false;
    const agentId = await this.deleterFor(row.repository_id);
    if (!agentId) {
      await this.pool.execute(
        `UPDATE vm_version_deletions
         SET error_code = 'repository_unavailable', error_message = ?,
             next_retry_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
         WHERE version_id = ? AND state = 'deleting'`,
        [
          SNAPSHOT_DELETE_REFUSAL_TEXT.repository_unavailable,
          this.options.retryBaseMs * 1000,
          versionId,
        ],
      );
      return false;
    }
    const attemptId = randomUUID();
    const attempts = Number(row.attempts) + 1;
    await this.pool.execute(
      `UPDATE vm_version_deletions
       SET attempt_id = ?, agent_id = ?, attempts = ?, dispatched_at = UTC_TIMESTAMP(3),
           next_retry_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
       WHERE version_id = ? AND state = 'deleting'`,
      [attemptId, agentId, attempts, this.delay(attempts) * 1000, versionId],
    );
    const payload: ArchiveDeletePayload = {
      operationId: attemptId,
      versionId,
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      repositoryId: row.repository_id,
      archiveKey: row.archive_key,
      archiveSizeBytes: Number(row.archive_size_bytes),
      archiveSha256: row.archive_sha256,
    };
    return this.link.send(agentId, { type: 'server.archive_delete', payload });
  }

  /** Every due attempt. Runs on a timer; one sweep at a time. */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        const [due] = await this.pool.execute<RowDataPacket[]>(
          `SELECT version_id FROM vm_version_deletions
           WHERE state = 'deleting' AND (next_retry_at IS NULL OR next_retry_at <= UTC_TIMESTAMP(3))
           ORDER BY requested_at LIMIT 50`,
        );
        for (const row of due) await this.attempt(row.version_id as string);
      } catch (error) {
        this.log.error({ err: error }, 'Cannot retry snapshot deletions');
      } finally {
        this.sweeping = null;
      }
    })();
    return this.sweeping;
  }

  /**
   * After an agent's welcome: deletions waiting on its repositories go to it now, unless the last attempt
   * went to an agent that is still online and may yet answer.
   */
  async synced(agentId: string, payload: RestoreSyncPayload): Promise<void> {
    const { capabilities } = payload;
    if (capabilities.deleteArchives !== true || capabilities.repositoryIds.length === 0) return;
    const ids = capabilities.repositoryIds;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT d.version_id, d.agent_id FROM vm_version_deletions AS d
       JOIN agent_repositories AS ar ON ar.repository_id = d.repository_id AND ar.agent_id = ?
       WHERE d.state = 'deleting' AND d.repository_id IN (${ids.map(() => '?').join(', ')})`,
      [agentId, ...ids],
    );
    for (const row of rows) {
      const last = row.agent_id as string | null;
      if (last && last !== agentId && this.link.isOnline(last)) continue;
      await this.attempt(row.version_id as string);
    }
  }

  async result(agentId: string, payload: ArchiveDeleteResultPayload): Promise<void> {
    const { versionId, operationId, outcome } = payload;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT d.state, d.attempt_id, d.attempts, ar.agent_id AS authorized
         FROM vm_version_deletions AS d
         LEFT JOIN agent_repositories AS ar ON ar.repository_id = d.repository_id AND ar.agent_id = ?
         WHERE d.version_id = ? FOR UPDATE`,
        [agentId, versionId],
      );
      const row = rows[0];
      if (!row || row.state !== 'deleting' || row.authorized === null) {
        await connection.commit();
        if (!row || row.authorized === null) {
          this.log.warn({ agentId, versionId }, 'An archive deletion result nobody asked for');
        }
        return;
      }
      if (outcome === 'deleted' || outcome === 'absent') {
        // Final from any attempt: the agent looked and found nothing at the key. Absent on the first
        // attempt means the repository never had it, as far as anyone here can tell.
        const archiveOutcome =
          outcome === 'absent' && Number(row.attempts) <= 1 ? 'already_absent' : 'deleted';
        await connection.execute(
          `UPDATE vm_version_deletions
           SET state = 'deleted', archive_outcome = ?, completed_at = UTC_TIMESTAMP(3),
               error_code = NULL, error_message = NULL, next_retry_at = NULL
           WHERE version_id = ?`,
          [archiveOutcome, versionId],
        );
        this.log.info({ versionId, archiveOutcome }, 'Snapshot deleted');
      } else if (operationId === row.attempt_id) {
        // Only the current attempt's failure counts; it is retried when its delay ends.
        await connection.execute(
          `UPDATE vm_version_deletions SET error_code = ?, error_message = ?
           WHERE version_id = ?`,
          [
            payload.code ?? 'internal_error',
            payload.message ?? 'The agent did not say why.',
            versionId,
          ],
        );
        this.log.warn({ versionId, code: payload.code }, 'Archive deletion failed; will retry');
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
