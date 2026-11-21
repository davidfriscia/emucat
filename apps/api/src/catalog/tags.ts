import {
  normalizeTagInput,
  normalizedTagKey,
  VERSION_DELETED_TEXT,
  type Tag,
  type VmIdentity,
} from '@emucat/contracts';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';
import { ApiError } from '../errors.js';

/**
 * The tag catalog and its associations (decision 0050). Tags are administrative to write. They are read publicly
 * only through the public catalog's own queries, for a public VM and its screenshots, never for versions, and
 * there is no public route that lists tags: a tag nobody public uses must not be discoverable.
 */

type Executor = Pool | PoolConnection;

/** LIKE has its own metacharacters. A search for `c++` or `50%` means that text. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function toTag(row: RowDataPacket): Tag {
  return { id: row.id as string, name: row.name as string };
}

/**
 * Tags whose normalized name contains the text, those that start with it first, then by name. Without text, the
 * most used tags first, so that the selector has something sensible to offer before anything is typed.
 */
export async function listTags(pool: Pool, q: string | undefined, limit: number): Promise<Tag[]> {
  const safeLimit = Math.trunc(limit);
  const text =
    q === undefined
      ? ''
      : normalizedTagKey(
          q.normalize('NFKC').trim().replace(/^#+/u, '').trim().replace(/\s+/gu, '-'),
        );
  if (text === '') {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT tag.id, tag.name,
              (SELECT COUNT(*) FROM vm_tags WHERE tag_id = tag.id)
              + (SELECT COUNT(*) FROM vm_version_tags WHERE tag_id = tag.id)
              + (SELECT COUNT(*) FROM vm_media_tags WHERE tag_id = tag.id) AS uses
       FROM tags AS tag
       ORDER BY uses DESC, tag.normalized_name, tag.id
       LIMIT ${safeLimit}`,
    );
    return rows.map(toTag);
  }
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, name FROM tags
     WHERE normalized_name LIKE ?
     ORDER BY normalized_name = ? DESC, normalized_name LIKE ? DESC, normalized_name, id
     LIMIT ${safeLimit}`,
    [likeContains(text), text, likePrefix(text)],
  );
  return rows.map(toTag);
}

/**
 * Creates a tag, or returns the one that already has this normalized name. Two administrators creating
 * `Retro` and `#retro` at the same moment get the same tag: the unique key decides, and the loser reads it.
 */
export async function createTag(
  pool: Pool,
  raw: string,
  userId: string | null,
): Promise<{ tag: Tag; created: boolean }> {
  const result = normalizeTagInput(raw);
  if (!result.ok) throw new ApiError(400, 'invalid_tag', result.message);
  const find = async () => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT id, name FROM tags WHERE normalized_name = ?',
      [result.normalizedName],
    );
    return rows[0] ? toTag(rows[0]) : null;
  };
  const existing = await find();
  if (existing) return { tag: existing, created: false };
  const id = randomUUID();
  try {
    await pool.execute(
      'INSERT INTO tags (id, name, normalized_name, created_by_user_id) VALUES (?, ?, ?, ?)',
      [id, result.name, result.normalizedName, userId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      const winner = await find();
      if (winner) return { tag: winner, created: false };
    }
    throw error;
  }
  return { tag: { id, name: result.name }, created: true };
}

/** Groups rows by a key column, keeping each group's tags in name order. */
function grouped(rows: RowDataPacket[], key: (row: RowDataPacket) => string): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(toTag(row));
    map.set(k, list);
  }
  return map;
}

/** A VM's key in the maps below. `vm_name` is case-insensitive, so the key is too. */
export function vmKey(vm: VmIdentity): string {
  return `${vm.emulatorType}/${vm.vmName.toLowerCase()}`;
}

/** The tags of many VMs in one query. */
export async function tagsOfVms(
  executor: Executor,
  vms: readonly VmIdentity[],
): Promise<Map<string, Tag[]>> {
  if (vms.length === 0) return new Map();
  const conditions = vms.map(() => '(vt.emulator_type = ? AND vt.vm_name = ?)').join(' OR ');
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT vt.emulator_type, vt.vm_name, tag.id, tag.name
     FROM vm_tags AS vt JOIN tags AS tag ON tag.id = vt.tag_id
     WHERE ${conditions}
     ORDER BY tag.normalized_name, tag.id`,
    vms.flatMap((vm) => [vm.emulatorType, vm.vmName]),
  );
  return grouped(rows, (row) =>
    vmKey({ emulatorType: row.emulator_type, vmName: row.vm_name as string }),
  );
}

/** The tags of every screenshot of one VM, in one query. */
export async function tagsOfVmMedia(
  executor: Executor,
  vm: VmIdentity,
): Promise<Map<string, Tag[]>> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT mt.media_id, tag.id, tag.name
     FROM vm_media_tags AS mt JOIN tags AS tag ON tag.id = mt.tag_id
     WHERE mt.emulator_type = ? AND mt.vm_name = ?
     ORDER BY tag.normalized_name, tag.id`,
    [vm.emulatorType, vm.vmName],
  );
  return grouped(rows, (row) => row.media_id as string);
}

/** The tags of every version of one VM, in one query. Administrators only (decision 0039). */
export async function tagsOfVmVersions(
  executor: Executor,
  vm: VmIdentity,
): Promise<Map<string, Tag[]>> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT xt.version_id, tag.id, tag.name
     FROM vm_version_tags AS xt JOIN tags AS tag ON tag.id = xt.tag_id
     WHERE xt.emulator_type = ? AND xt.vm_name = ?
     ORDER BY tag.normalized_name, tag.id`,
    [vm.emulatorType, vm.vmName],
  );
  return grouped(rows, (row) => row.version_id as string);
}

/** Every requested tag must exist. Read under a shared lock, so that none can disappear before the commit. */
async function requireTags(connection: PoolConnection, tagIds: readonly string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const placeholders = tagIds.map(() => '?').join(', ');
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM tags WHERE id IN (${placeholders}) LOCK IN SHARE MODE`,
    [...tagIds],
  );
  if (rows.length !== new Set(tagIds.map((id) => id.toLowerCase())).size) {
    throw new ApiError(422, 'unknown_tag', 'A tag does not exist. Reload the tags and try again');
  }
}

interface Association {
  table: 'vm_tags' | 'vm_version_tags' | 'vm_media_tags';
  /** The columns that name the entity, and their values. */
  columns: Record<string, string>;
}

/**
 * Makes an entity's tags exactly `tagIds`, in the caller's transaction: what is no longer wanted goes, what is
 * new is added, and what stays is not touched, so its `created_at` keeps saying when it was first assigned.
 */
async function replaceTags(
  connection: PoolConnection,
  { table, columns }: Association,
  tagIds: readonly string[],
): Promise<void> {
  await requireTags(connection, tagIds);
  const names = Object.keys(columns);
  const values = Object.values(columns);
  const where = names.map((name) => `${name} = ?`).join(' AND ');
  if (tagIds.length === 0) {
    await connection.execute(`DELETE FROM ${table} WHERE ${where}`, values);
    return;
  }
  const placeholders = tagIds.map(() => '?').join(', ');
  await connection.execute(
    `DELETE FROM ${table} WHERE ${where} AND tag_id NOT IN (${placeholders})`,
    [...values, ...tagIds],
  );
  const rowPlaceholders = tagIds.map(() => `(${[...names, 'tag_id'].map(() => '?').join(', ')})`);
  await connection.execute(
    `INSERT IGNORE INTO ${table} (${[...names, 'tag_id'].join(', ')}) VALUES ${rowPlaceholders.join(', ')}`,
    tagIds.flatMap((tagId) => [...values, tagId]),
  );
}

async function readTags(
  connection: PoolConnection,
  { table, columns }: Association,
): Promise<Tag[]> {
  const where = Object.keys(columns)
    .map((name) => `a.${name} = ?`)
    .join(' AND ');
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT tag.id, tag.name FROM ${table} AS a JOIN tags AS tag ON tag.id = a.tag_id
     WHERE ${where} ORDER BY tag.normalized_name, tag.id`,
    Object.values(columns),
  );
  return rows.map(toTag);
}

const vmNotFound = () => new ApiError(404, 'vm_not_found', 'Virtual machine not found');

/** The VM row lock that every change to a VM's media already takes, in the same order. */
async function lockVm(connection: PoolConnection, vm: VmIdentity): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ? FOR UPDATE',
    [vm.emulatorType, vm.vmName],
  );
  if (rows.length === 0) throw vmNotFound();
}

function vmAssociation(vm: VmIdentity): Association {
  return { table: 'vm_tags', columns: { emulator_type: vm.emulatorType, vm_name: vm.vmName } };
}

export async function getVmTags(pool: Pool, vm: VmIdentity): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
      [vm.emulatorType, vm.vmName],
    );
    if (rows.length === 0) throw vmNotFound();
    return readTags(connection, vmAssociation(vm));
  });
}

export async function setVmTags(
  pool: Pool,
  vm: VmIdentity,
  tagIds: readonly string[],
): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    await replaceTags(connection, vmAssociation(vm), tagIds);
    return readTags(connection, vmAssociation(vm));
  });
}

async function requireMedia(
  connection: PoolConnection,
  vm: VmIdentity,
  mediaId: string,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT 1 FROM vm_media WHERE id = ? AND emulator_type = ? AND vm_name = ?',
    [mediaId, vm.emulatorType, vm.vmName],
  );
  if (rows.length === 0) throw new ApiError(404, 'media_not_found', 'Media not found');
}

function mediaAssociation(vm: VmIdentity, mediaId: string): Association {
  return {
    table: 'vm_media_tags',
    columns: { media_id: mediaId, emulator_type: vm.emulatorType, vm_name: vm.vmName },
  };
}

export async function getMediaTags(pool: Pool, vm: VmIdentity, mediaId: string): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    await requireMedia(connection, vm, mediaId);
    return readTags(connection, mediaAssociation(vm, mediaId));
  });
}

/** Under the VM's lock, so that the screenshot cannot be deleted half way through. */
export async function setMediaTags(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
  tagIds: readonly string[],
): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    await requireMedia(connection, vm, mediaId);
    await replaceTags(connection, mediaAssociation(vm, mediaId), tagIds);
    return readTags(connection, mediaAssociation(vm, mediaId));
  });
}

/**
 * A version of this VM that is not deleted or being deleted. Scoped to the VM, so a version of another VM is
 * simply not found. Locked, like an edit of its title, so that a deletion waits for this to finish.
 */
async function requireLiveVersion(
  connection: PoolConnection,
  vm: VmIdentity,
  versionId: string,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM vm_versions WHERE id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE',
    [versionId, vm.emulatorType, vm.vmName],
  );
  if (rows.length === 0) throw new ApiError(404, 'version_not_found', 'Version not found');
  const [tombstones] = await connection.execute<RowDataPacket[]>(
    'SELECT 1 FROM vm_version_deletions WHERE version_id = ? LOCK IN SHARE MODE',
    [versionId],
  );
  if (tombstones.length > 0) throw new ApiError(409, 'version_deleted', VERSION_DELETED_TEXT);
}

function versionAssociation(vm: VmIdentity, versionId: string): Association {
  return {
    table: 'vm_version_tags',
    columns: { version_id: versionId, emulator_type: vm.emulatorType, vm_name: vm.vmName },
  };
}

export async function getVersionTags(
  pool: Pool,
  vm: VmIdentity,
  versionId: string,
): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_versions WHERE id = ? AND emulator_type = ? AND vm_name = ?',
      [versionId, vm.emulatorType, vm.vmName],
    );
    if (rows.length === 0) throw new ApiError(404, 'version_not_found', 'Version not found');
    return readTags(connection, versionAssociation(vm, versionId));
  });
}

export async function setVersionTags(
  pool: Pool,
  vm: VmIdentity,
  versionId: string,
  tagIds: readonly string[],
): Promise<Tag[]> {
  return withTransaction(pool, async (connection) => {
    await requireLiveVersion(connection, vm, versionId);
    await replaceTags(connection, versionAssociation(vm, versionId), tagIds);
    return readTags(connection, versionAssociation(vm, versionId));
  });
}
