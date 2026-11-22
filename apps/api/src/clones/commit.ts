import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/**
 * A clone's commit (decision 0052), inside the registration commit transaction: the new VM, its one master, and its
 * provenance, and nothing else. No agent holds a copy of the new VM, so there is no agent state; no VirtualBox
 * machine is linked; no tag, screenshot, note, session, operation history or publication comes from the source. The
 * new VM is private, with no display name and no description, as any newly registered VM is.
 *
 * The provenance is copied as values. The source version's row is read here only to label it, and an absent source
 * does not stop the commit: the archive was verified against the values recorded when the clone was created.
 */
export async function commitCloneIn(connection: PoolConnection, row: RowDataPacket): Promise<void> {
  await connection.execute(
    `INSERT INTO virtual_machines
       (emulator_type, vm_name, registered_by_user_id, discovered_by_agent_id)
     VALUES (?, ?, ?, NULL)`,
    [row.emulator_type, row.vm_name, row.requested_by_user_id],
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

  const [sources] = await connection.execute<RowDataPacket[]>(
    `SELECT version.kind, version.snapshot_name, version.title, vm.display_name
     FROM vm_versions AS version
     LEFT JOIN virtual_machines AS vm
       ON vm.emulator_type = version.emulator_type AND vm.vm_name = version.vm_name
     WHERE version.id = ?`,
    [row.clone_source_version_id],
  );
  const source = sources[0];
  await connection.execute(
    `INSERT INTO vm_clone_provenance
       (emulator_type, vm_name, source_vm_name, source_display_name, source_version_id,
        source_version_kind, source_snapshot_name, source_version_title, operation_id,
        cloned_by_user_id, cloned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      row.emulator_type,
      row.vm_name,
      row.clone_source_vm_name,
      (source?.display_name as string | null | undefined) ?? null,
      row.clone_source_version_id,
      (source?.kind as string | undefined) ?? 'master',
      (source?.snapshot_name as string | null | undefined) ?? null,
      (source?.title as string | null | undefined) ?? null,
      row.id,
      row.requested_by_user_id,
    ],
  );

  // A clone has no local copy to clean up: the agent only ever wrote to its staging directory.
  await connection.execute(
    `UPDATE registration_operations
     SET state = 'succeeded', local_copy = 'preserved', committed_at = UTC_TIMESTAMP(3),
         finished_at = UTC_TIMESTAMP(3), progress_done_bytes = NULL, progress_total_bytes = NULL
     WHERE id = ?`,
    [row.id],
  );
}
