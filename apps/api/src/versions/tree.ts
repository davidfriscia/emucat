import type {
  VersionDeletability,
  VersionHolder,
  VersionNode,
  VersionTreeResponse,
  VmIdentity,
} from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** Whether each version could be deleted now. Without one, nothing is offered for deletion. */
export interface DeletabilitySource {
  deletability(vm: VmIdentity): Promise<Map<string, VersionDeletability>>;
}

const NOT_DELETABLE: VersionDeletability = { eligible: false, reason: 'repository_unavailable' };
const MASTER: VersionDeletability = { eligible: false, reason: 'master_cannot_be_deleted' };

/**
 * A VM's versions as a tree: every node with its parent and children, oldest first. Administrators only
 * (decision 0039), and even then without archive keys, repository addresses or local paths.
 */
export async function versionTree(
  pool: Pool,
  vm: VmIdentity,
  deletions: DeletabilitySource | null = null,
): Promise<VersionTreeResponse> {
  // A deleted snapshot leaves the tree; one being deleted stays, marked, until its archive is gone. Only
  // leaves are deleted, so what remains is still a tree (decision 0041).
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT version.id, version.vm_name, version.kind, version.parent_version_id,
            version.snapshot_name, version.created_at, version.archive_size_bytes,
            version.archive_sha256, r.name AS repository_name, r.enabled AS repository_enabled,
            a.name AS agent_name, u.display_name AS user_display_name,
            reg.manifest_sha256, reg.file_count, reg.total_uncompressed_bytes,
            d.requested_at AS deletion_requested_at, d.attempts AS deletion_attempts,
            d.error_code AS deletion_error_code, d.error_message AS deletion_error_message
     FROM vm_versions AS version
     JOIN repositories AS r ON r.id = version.repository_id
     LEFT JOIN agents AS a ON a.id = version.created_by_agent_id
     LEFT JOIN users AS u ON u.id = version.created_by_user_id
     LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
     LEFT JOIN vm_version_deletions AS d ON d.version_id = version.id
     WHERE version.emulator_type = ? AND version.vm_name = ?
       AND (d.state IS NULL OR d.state <> 'deleted')
     ORDER BY version.created_at, version.id`,
    [vm.emulatorType, vm.vmName],
  );
  const deletable = (await deletions?.deletability(vm)) ?? new Map<string, VersionDeletability>();

  const holders = new Map<string, VersionHolder[]>();
  const add = (versionId: string, holder: VersionHolder) => {
    const list = holders.get(versionId) ?? [];
    list.push(holder);
    holders.set(versionId, list);
  };
  const [copies] = await pool.execute<RowDataPacket[]>(
    `SELECT s.agent_id, a.name, s.local_source_version_id, s.content_status
     FROM agent_vm_state AS s JOIN agents AS a ON a.id = s.agent_id
     WHERE s.emulator_type = ? AND s.vm_name = ? AND s.local_source_version_id IS NOT NULL
       AND s.execution_state <> 'absent' AND a.revoked_at IS NULL
     ORDER BY a.name`,
    [vm.emulatorType, vm.vmName],
  );
  for (const copy of copies) {
    add(copy.local_source_version_id as string, {
      agentId: copy.agent_id as string,
      agentName: copy.name as string,
      kind: 'local',
      contentStatus: copy.content_status as VersionHolder['contentStatus'],
      workspaceId: null,
    });
  }
  const [workspaces] = await pool.execute<RowDataPacket[]>(
    `SELECT w.id, w.agent_id, a.name, w.source_version_id
     FROM vm_workspaces AS w JOIN agents AS a ON a.id = w.agent_id
     WHERE w.emulator_type = ? AND w.vm_name = ? AND w.state IN ('ready', 'discarding')
     ORDER BY a.name`,
    [vm.emulatorType, vm.vmName],
  );
  for (const workspace of workspaces) {
    add(workspace.source_version_id as string, {
      agentId: workspace.agent_id as string,
      agentName: workspace.name as string,
      kind: 'workspace',
      contentStatus: null,
      workspaceId: workspace.id as string,
    });
  }

  const children = new Map<string, string[]>();
  for (const row of rows) {
    const parent = row.parent_version_id as string | null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), row.id as string]);
  }
  const versions: VersionNode[] = rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as VersionNode['kind'],
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    childVersionIds: children.get(row.id as string) ?? [],
    snapshotName: (row.snapshot_name as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    archiveSizeBytes: Number(row.archive_size_bytes),
    archiveSha256: row.archive_sha256 as string,
    manifest: row.manifest_sha256
      ? {
          sha256: row.manifest_sha256 as string,
          fileCount: Number(row.file_count),
          totalUncompressedBytes: Number(row.total_uncompressed_bytes),
          verifiedBy: 'agent',
        }
      : null,
    repositoryName: row.repository_name as string,
    available: Boolean(row.repository_enabled) && !row.deletion_requested_at,
    createdByAgentName: (row.agent_name as string | null) ?? null,
    createdByDisplayName: (row.user_display_name as string | null) ?? null,
    holders: holders.get(row.id as string) ?? [],
    deletion: row.deletion_requested_at
      ? {
          requestedAt: (row.deletion_requested_at as Date).toISOString(),
          attempts: Number(row.deletion_attempts),
          error: row.deletion_error_code
            ? {
                code: row.deletion_error_code as string,
                message: (row.deletion_error_message as string | null) ?? '',
              }
            : null,
        }
      : null,
    deletable: row.deletion_requested_at
      ? { eligible: false, reason: null }
      : row.kind === 'master'
        ? MASTER
        : (deletable.get(row.id as string) ?? NOT_DELETABLE),
  }));
  return {
    emulatorType: vm.emulatorType,
    vmName: (rows[0]?.vm_name as string | undefined) ?? vm.vmName,
    rootVersionId: versions.find((version) => version.kind === 'master')?.id ?? null,
    versions,
  };
}
