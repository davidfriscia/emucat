import { createHash } from 'node:crypto';
import {
  remasterPlan,
  type RemasterVersion,
  type VersionKind,
  type VmIdentity,
} from '@emucat/contracts';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

/** One version of a VM, as a remaster sees it: its lineage, its archive, and whether it is tombstoned. */
export interface GraphVersion {
  id: string;
  kind: VersionKind;
  parentVersionId: string | null;
  snapshotName: string | null;
  title: string | null;
  createdAt: Date;
  retired: boolean;
  repositoryId: string;
  archiveKey: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  /** `deleting` or `deleted` when tombstoned (decision 0041), else `null`. */
  deletion: 'deleting' | 'deleted' | null;
}

export interface VersionGraph {
  vmName: string;
  /** Every version of the VM, tombstoned ones included, by ID order. */
  all: GraphVersion[];
  /** The versions that are not tombstoned: the live history. */
  active: GraphVersion[];
  /** The live master, or `null` if there is none (or several, which the schema makes impossible). */
  master: GraphVersion | null;
  /** Whether the live history is one tree under its master, by lineage. */
  consistent: boolean;
  revision: string;
}

const SELECT_GRAPH = `
  SELECT version.id, version.vm_name, version.kind, version.parent_version_id, version.snapshot_name,
         version.title, version.created_at, version.retired_at, version.repository_id,
         version.archive_key, version.archive_sha256, version.archive_size_bytes, d.state AS deletion
  FROM vm_versions AS version
  LEFT JOIN vm_version_deletions AS d ON d.version_id = version.id
  WHERE version.emulator_type = ? AND version.vm_name = ?
  ORDER BY version.id`;

/**
 * Identifies one exact history: every version, its kind and parent, whether it is the master and whether it is
 * tombstoned. Titles and descriptions are not part of it: editing them stales nothing.
 */
export function graphRevision(all: readonly GraphVersion[]): string {
  const lines = [...all]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (version) =>
        `${version.id}|${version.kind}|${version.parentVersionId ?? ''}|${version.retired ? 'r' : ''}|${version.deletion === null ? '' : 'd'}`,
    );
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * A VM's versions. With `lock`, inside a transaction, every version and tombstone row is locked exclusively,
 * in ID order: whatever creates a reference to a version locks it in share mode first, so nothing can start
 * using a version while a remaster decides about it (decision 0048).
 */
export async function loadGraph(
  executor: Pool | PoolConnection,
  vm: VmIdentity,
  lock = false,
): Promise<VersionGraph> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `${SELECT_GRAPH}${lock ? ' FOR UPDATE' : ''}`,
    [vm.emulatorType, vm.vmName],
  );
  const all: GraphVersion[] = rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as VersionKind,
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    snapshotName: (row.snapshot_name as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    createdAt: row.created_at as Date,
    retired: row.retired_at !== null,
    repositoryId: row.repository_id as string,
    archiveKey: row.archive_key as string,
    archiveSha256: row.archive_sha256 as string,
    archiveSizeBytes: Number(row.archive_size_bytes),
    deletion: (row.deletion as GraphVersion['deletion']) ?? null,
  }));
  const active = all.filter((version) => version.deletion === null);
  const masters = active.filter((version) => version.kind === 'master' && !version.retired);
  const master = masters.length === 1 ? (masters[0] as GraphVersion) : null;
  const consistent =
    master !== null &&
    active.every((version) => !version.retired) &&
    remasterPlan(active, master.id) !== null;
  return {
    vmName: (rows[0]?.vm_name as string | undefined) ?? vm.vmName,
    all,
    active,
    master,
    consistent,
    revision: graphRevision(all),
  };
}

/** Oldest first, by creation time and then ID: only for listing, never for lineage. */
export function oldestFirst(versions: readonly GraphVersion[]): GraphVersion[] {
  return [...versions].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

export function describeVersion(version: GraphVersion): RemasterVersion {
  return {
    id: version.id,
    kind: version.kind,
    parentVersionId: version.parentVersionId,
    snapshotName: version.snapshotName,
    title: version.title,
    createdAt: version.createdAt.toISOString(),
    archiveSizeBytes: version.archiveSizeBytes,
  };
}

/** How an administrator recognizes a version: its title, its label, or what it is. Never only a date. */
export function versionLabel(
  version: Pick<GraphVersion, 'kind' | 'snapshotName' | 'title' | 'id'>,
) {
  const name =
    version.title ?? version.snapshotName ?? (version.kind === 'master' ? 'Master' : 'Snapshot');
  return `${name} (${version.id.slice(0, 8)})`;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether a version's archive can still be verified: a positive size and a SHA-256. */
export function hasArchiveIntegrity(version: GraphVersion): boolean {
  return version.archiveSizeBytes > 0 && SHA256.test(version.archiveSha256);
}
