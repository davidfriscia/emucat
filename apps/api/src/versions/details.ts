import { VERSION_DELETED_TEXT, type VersionDetails, type VmIdentity } from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';

/**
 * Sets a version's title and description (decision 0048). Nothing else changes: not the archive, its hash or
 * size, the lineage or the creation time, which the version's trigger refuses to let change anyway, and nothing
 * is exported or uploaded. Both values are already normalized plain text, or `null`.
 */
export async function updateVersionDetails(
  pool: Pool,
  vm: VmIdentity,
  versionId: string,
  details: { title: string | null; description: string | null },
): Promise<VersionDetails> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Scoped to the VM: a version of another VM is simply not found.
    const [versions] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM vm_versions WHERE id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
      [versionId, vm.emulatorType, vm.vmName],
    );
    if (versions.length === 0) throw new ApiError(404, 'version_not_found', 'Version not found');
    const [tombstones] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_version_deletions WHERE version_id = ? LOCK IN SHARE MODE',
      [versionId],
    );
    if (tombstones.length > 0) throw new ApiError(409, 'version_deleted', VERSION_DELETED_TEXT);
    await connection.execute('UPDATE vm_versions SET title = ?, description = ? WHERE id = ?', [
      details.title,
      details.description,
      versionId,
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { versionId, title: details.title, description: details.description };
}
