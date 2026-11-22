import { isRepositoryKey, isStagingKey, REPOSITORY_STAGING_PREFIX } from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';

/**
 * What an agent may do to a repository through the server's relay (decision 0055). Never more than the agent could
 * do with its own SFTP connection, and usually much less: it may read what EmuCat registered in that repository and
 * what its own operations wrote, write only the staging key of one of its own running operations, publish only that
 * operation's archive, and delete only what its own unfinished operations wrote or what a deletion asked it to.
 * Every decision is made from database rows; the request supplies keys, which are only ever compared with them.
 */

const STAGING = new RegExp(
  `^${REPOSITORY_STAGING_PREFIX.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}([0-9a-f-]{36})\\.part$`,
  'u',
);

/** The operation a staging key belongs to, when it is one an operation would use. */
export function operationOfStagingKey(key: string): string | null {
  return STAGING.exec(key)?.[1] ?? null;
}

const notAllowed = () =>
  new ApiError(
    403,
    'repository_not_authorized',
    'This agent may not use that object through the relay.',
  );

export interface ReadGrant {
  /** What the server registered for this object, when it did: a download is checked against it. */
  expectedSizeBytes: number | null;
  expectedSha256: string | null;
}

export class RelayAuthorization {
  constructor(private readonly pool: Pool) {}

  /** The agent is associated with an enabled repository. Everything else builds on this. */
  async requireRepository(agentId: string, repositoryId: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT r.enabled FROM repositories AS r
       JOIN agent_repositories AS ar ON ar.repository_id = r.id AND ar.agent_id = ?
       JOIN agents AS a ON a.id = ar.agent_id
       WHERE r.id = ? AND r.kind = 'sftp' AND a.revoked_at IS NULL`,
      [agentId, repositoryId],
    );
    if (!rows[0]) {
      throw new ApiError(
        403,
        'repository_not_authorized',
        'This agent is not associated with this repository.',
      );
    }
    if (!rows[0].enabled) {
      throw new ApiError(409, 'repository_disabled', 'This repository is disabled.');
    }
  }

  /** Stat, download and verify. */
  async read(agentId: string, repositoryId: string, key: string): Promise<ReadGrant> {
    if (!isRepositoryKey(key)) throw notAllowed();
    const operationId = operationOfStagingKey(key);
    if (operationId) {
      const [own] = await this.pool.execute<RowDataPacket[]>(
        'SELECT 1 FROM registration_operations WHERE id = ? AND agent_id = ? AND repository_id = ?',
        [operationId, agentId, repositoryId],
      );
      if (own[0]) return { expectedSizeBytes: null, expectedSha256: null };
      throw notAllowed();
    }
    if (isStagingKey(key)) throw notAllowed();
    const [versions] = await this.pool.execute<RowDataPacket[]>(
      `SELECT archive_size_bytes, archive_sha256 FROM vm_versions
       WHERE repository_id = ? AND archive_key = ?`,
      [repositoryId, key],
    );
    if (versions[0]) {
      return {
        expectedSizeBytes: Number(versions[0].archive_size_bytes),
        expectedSha256: versions[0].archive_sha256 as string,
      };
    }
    const [operations] = await this.pool.execute<RowDataPacket[]>(
      `SELECT archive_size_bytes, archive_sha256 FROM registration_operations
       WHERE agent_id = ? AND repository_id = ? AND archive_key = ?
       UNION ALL
       SELECT clone_source_archive_size_bytes, clone_source_archive_sha256 FROM registration_operations
       WHERE agent_id = ? AND repository_id = ? AND clone_source_archive_key = ?
       LIMIT 1`,
      [agentId, repositoryId, key, agentId, repositoryId, key],
    );
    if (operations[0]) {
      const size = operations[0].archive_size_bytes;
      return {
        expectedSizeBytes: size === null ? null : Number(size),
        expectedSha256: (operations[0].archive_sha256 as string | null) ?? null,
      };
    }
    throw notAllowed();
  }

  /** An upload: only the staging key of one of this agent's own operations that is still running. */
  async write(agentId: string, repositoryId: string, key: string): Promise<string> {
    const operationId = operationOfStagingKey(key);
    if (!operationId) throw notAllowed();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM registration_operations
       WHERE id = ? AND agent_id = ? AND repository_id = ? AND active_marker = 1
         AND state NOT IN ('committing', 'cleaning_local')`,
      [operationId, agentId, repositoryId],
    );
    if (!rows[0]) throw notAllowed();
    return operationId;
  }

  /** A publication: that operation's staging key to that operation's own archive key, nothing else. */
  async publish(
    agentId: string,
    repositoryId: string,
    stagingKey: string,
    finalKey: string,
  ): Promise<void> {
    const operationId = operationOfStagingKey(stagingKey);
    if (!operationId) throw notAllowed();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM registration_operations
       WHERE id = ? AND agent_id = ? AND repository_id = ? AND archive_key = ? AND active_marker = 1`,
      [operationId, agentId, repositoryId, finalKey],
    );
    if (!rows[0]) throw notAllowed();
  }

  /**
   * A removal: what this agent's own operations wrote while they cannot have produced a version (their staging key
   * always; their archive only before a commit), or the archive of a version whose deletion was sent to this agent.
   */
  async remove(agentId: string, repositoryId: string, key: string): Promise<void> {
    if (!isRepositoryKey(key)) throw notAllowed();
    const operationId = operationOfStagingKey(key);
    if (operationId) {
      const [own] = await this.pool.execute<RowDataPacket[]>(
        'SELECT 1 FROM registration_operations WHERE id = ? AND agent_id = ? AND repository_id = ?',
        [operationId, agentId, repositoryId],
      );
      if (own[0]) return;
      throw notAllowed();
    }
    const [uncommitted] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM registration_operations AS op
       WHERE op.agent_id = ? AND op.repository_id = ? AND op.archive_key = ?
         AND op.committed_at IS NULL
         AND op.state NOT IN ('succeeded', 'cleaning_local', 'partial_success')
         AND NOT EXISTS (SELECT 1 FROM vm_versions AS v WHERE v.archive_key = op.archive_key)`,
      [agentId, repositoryId, key],
    );
    if (uncommitted[0]) return;
    const [deletions] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM vm_version_deletions
       WHERE repository_id = ? AND archive_key = ? AND state = 'deleting' AND agent_id = ?`,
      [repositoryId, key, agentId],
    );
    if (deletions[0]) return;
    throw notAllowed();
  }
}
