import {
  CATALOG_SUMMARY_LENGTH,
  type AdminCatalogQuery,
  type AdminMedia,
  type AdminMediaDetail,
  type AdminMediaVariant,
  type AdminSummaryResponse,
  type AdminVmCard,
  type AdminVmDetail,
  type EmulatorType,
  type MediaVariant,
  type MediaVisibility,
  type Pagination,
  type PublicCatalogQuery,
  type PublicMedia,
  type PublicVmCard,
  type PublicVmDetail,
  type UpdateVmMetadataRequest,
  type VmIdentity,
  type VmVisibility,
} from '@emucat/contracts';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';

/**
 * All catalog SQL. Queries name every column they read, and the mappers below build each response
 * field by field, so a column added to a table later cannot reach a response by accident.
 *
 * Public queries read card images only through `public_catalog_card_media`, and media files only
 * after checking that both the VM is public and the media is published.
 */

export class CatalogNotFoundError extends Error {
  constructor(readonly entity: 'vm' | 'media') {
    super(`${entity} not found`);
    this.name = 'CatalogNotFoundError';
  }
}

/** `vm_name` is ASCII. This lets it sort and search alongside the utf8mb4 display name. */
const VM_NAME_TEXT = 'CONVERT(vm.vm_name USING utf8mb4) COLLATE utf8mb4_uca1400_ai_ci';
const TITLE_ORDER = `COALESCE(vm.display_name, ${VM_NAME_TEXT}), vm.emulator_type, vm.vm_name`;

interface Filter {
  clause: string;
  values: string[];
}

/** LIKE has its own metacharacters. A search for `50%` must mean that text, not a pattern. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function catalogFilter(query: {
  q?: string | undefined;
  emulatorType?: EmulatorType | undefined;
  visibility?: VmVisibility | undefined;
}): Filter {
  const conditions: string[] = [];
  const values: string[] = [];
  if (query.visibility) {
    conditions.push('vm.visibility = ?');
    values.push(query.visibility);
  }
  if (query.emulatorType) {
    conditions.push('vm.emulator_type = ?');
    values.push(query.emulatorType);
  }
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(`(vm.display_name LIKE ? OR ${VM_NAME_TEXT} LIKE ? OR vm.description LIKE ?)`);
    values.push(pattern, pattern, pattern);
  }
  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

function paginate(page: number, pageSize: number, total: number): Pagination {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/** Both come from validated integers, so they are safe to embed. MariaDB's prepared `LIMIT ?` is not. */
function limitClause(page: number, pageSize: number): string {
  return `LIMIT ${Math.trunc(pageSize)} OFFSET ${Math.trunc((page - 1) * pageSize)}`;
}

interface PublicVmRow extends RowDataPacket {
  emulator_type: EmulatorType;
  vm_name: string;
  display_name: string | null;
  summary: string | null;
  description: string | null;
  media_id: string | null;
  width_px: number | null;
  height_px: number | null;
}

function publicImage(row: PublicVmRow): PublicMedia | null {
  return row.media_id && row.width_px && row.height_px
    ? { id: row.media_id, widthPx: row.width_px, heightPx: row.height_px }
    : null;
}

export async function listPublicVms(
  pool: Pool,
  query: PublicCatalogQuery,
): Promise<{ items: PublicVmCard[]; pagination: Pagination }> {
  const filter = catalogFilter({ ...query, visibility: 'public' });
  const [counts] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM virtual_machines AS vm ${filter.clause}`,
    filter.values,
  );
  const [rows] = await pool.execute<PublicVmRow[]>(
    `SELECT vm.emulator_type, vm.vm_name, vm.display_name,
            LEFT(vm.description, ${CATALOG_SUMMARY_LENGTH}) AS summary,
            card.media_id, card.width_px, card.height_px
     FROM virtual_machines AS vm
     LEFT JOIN public_catalog_card_media AS card
       ON card.emulator_type = vm.emulator_type AND card.vm_name = vm.vm_name
     ${filter.clause}
     ORDER BY ${TITLE_ORDER}
     ${limitClause(query.page, query.pageSize)}`,
    filter.values,
  );
  return {
    items: rows.map((row) => ({
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      displayName: row.display_name,
      summary: row.summary,
      mainImage: publicImage(row),
    })),
    pagination: paginate(query.page, query.pageSize, Number(counts[0]?.total)),
  };
}

export async function getPublicVm(pool: Pool, vm: VmIdentity): Promise<PublicVmDetail | null> {
  const [rows] = await pool.execute<PublicVmRow[]>(
    `SELECT vm.emulator_type, vm.vm_name, vm.display_name, vm.description,
            card.media_id, card.width_px, card.height_px
     FROM virtual_machines AS vm
     LEFT JOIN public_catalog_card_media AS card
       ON card.emulator_type = vm.emulator_type AND card.vm_name = vm.vm_name
     WHERE vm.visibility = 'public' AND vm.emulator_type = ? AND vm.vm_name = ?`,
    [vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  if (!row) return null;
  const [gallery] = await pool.execute<RowDataPacket[]>(
    `SELECT id, width_px, height_px
     FROM vm_media
     WHERE emulator_type = ? AND vm_name = ? AND visibility = 'published'
     ORDER BY is_main DESC, COALESCE(captured_at, created_at), id`,
    [vm.emulatorType, vm.vmName],
  );
  return {
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    displayName: row.display_name,
    description: row.description,
    mainImage: publicImage(row),
    gallery: gallery.map((item) => ({
      id: item.id as string,
      widthPx: item.width_px as number,
      heightPx: item.height_px as number,
    })),
  };
}

function storageKeyColumn(variant: MediaVariant): 'jpeg_key' | 'thumbnail_key' {
  return variant === 'full' ? 'jpeg_key' : 'thumbnail_key';
}

/** The storage key of a file the public may see, or `null` for anything else. */
export async function publicMediaKey(
  pool: Pool,
  mediaId: string,
  variant: MediaVariant,
): Promise<string | null> {
  const column = storageKeyColumn(variant);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT media.${column} AS storage_key
     FROM vm_media AS media
     JOIN virtual_machines AS vm
       ON vm.emulator_type = media.emulator_type AND vm.vm_name = media.vm_name
     WHERE media.id = ? AND media.visibility = 'published' AND vm.visibility = 'public'`,
    [mediaId],
  );
  return (rows[0]?.storage_key as string | undefined) ?? null;
}

/** A name for the `Content-Disposition` header: its base name, in characters that need no escaping. */
function downloadName(originalFilename: string): string {
  const base = originalFilename.split('/').at(-1) ?? 'screenshot';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return safe === '' ? 'screenshot' : safe;
}

/** Where an item's file is. An original also says how to present it, and legacy rows have none. */
export async function adminMediaFile(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
  variant: AdminMediaVariant,
): Promise<{ key: string | null; original?: { mimeType: string; downloadName: string } }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT jpeg_key, thumbnail_key, original_key, original_mime, original_filename FROM vm_media
     WHERE id = ? AND emulator_type = ? AND vm_name = ?`,
    [mediaId, vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  if (!row) return { key: null };
  if (variant !== 'original') {
    return { key: row[storageKeyColumn(variant)] as string };
  }
  if (!row.original_key) return { key: null };
  return {
    key: row.original_key as string,
    original: {
      mimeType: row.original_mime as string,
      downloadName: downloadName(row.original_filename as string),
    },
  };
}

/** One item in full, for the administration interface. Storage keys stay out of every response. */
export async function getAdminMedia(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
): Promise<AdminMediaDetail | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT media.original_sha256, media.original_mime, media.uploaded_by_agent_id,
            agent.name AS agent_name
     FROM vm_media AS media
     LEFT JOIN agents AS agent ON agent.id = media.uploaded_by_agent_id
     WHERE media.id = ? AND media.emulator_type = ? AND media.vm_name = ?`,
    [mediaId, vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  const listed = (await listAdminMedia(pool, vm)).find((item) => item.id === mediaId);
  if (!row || !listed) return null;
  return {
    ...listed,
    originalSha256: row.original_sha256 as string,
    originalMimeType: (row.original_mime as string | null) ?? null,
    uploadedByAgentId: (row.uploaded_by_agent_id as string | null) ?? null,
    uploadedByAgentName: (row.agent_name as string | null) ?? null,
  };
}

/** The agents that have or had a copy of this VM, and so may be synchronizing its screenshots. */
export async function agentsHoldingVm(
  pool: Pool,
  vm: VmIdentity,
): Promise<{ id: string; name: string }[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT agent.id, agent.name
     FROM agent_vm_state AS state
     JOIN agents AS agent ON agent.id = state.agent_id
     WHERE state.emulator_type = ? AND state.vm_name = ? AND agent.revoked_at IS NULL
     ORDER BY agent.name, agent.id`,
    [vm.emulatorType, vm.vmName],
  );
  return rows.map((row) => ({ id: row.id as string, name: row.name as string }));
}

const ADMIN_VM_COLUMNS = `
  vm.emulator_type, vm.vm_name, vm.display_name, vm.visibility, vm.created_at, vm.updated_at,
  main.id AS main_media_id,
  (SELECT COUNT(*) FROM vm_media AS media
    WHERE media.emulator_type = vm.emulator_type AND media.vm_name = vm.vm_name) AS media_count`;

const ADMIN_VM_JOIN = `
  LEFT JOIN vm_media AS main
    ON main.emulator_type = vm.emulator_type AND main.vm_name = vm.vm_name AND main.is_main`;

interface AdminVmRow extends RowDataPacket {
  emulator_type: EmulatorType;
  vm_name: string;
  display_name: string | null;
  summary: string | null;
  description: string | null;
  visibility: VmVisibility;
  main_media_id: string | null;
  media_count: number;
  version_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function listAdminVms(
  pool: Pool,
  query: AdminCatalogQuery,
): Promise<{ items: AdminVmCard[]; pagination: Pagination }> {
  const filter = catalogFilter(query);
  const [counts] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM virtual_machines AS vm ${filter.clause}`,
    filter.values,
  );
  const [rows] = await pool.execute<AdminVmRow[]>(
    `SELECT ${ADMIN_VM_COLUMNS}, LEFT(vm.description, ${CATALOG_SUMMARY_LENGTH}) AS summary
     FROM virtual_machines AS vm
     ${ADMIN_VM_JOIN}
     ${filter.clause}
     ORDER BY ${TITLE_ORDER}
     ${limitClause(query.page, query.pageSize)}`,
    filter.values,
  );
  return {
    items: rows.map((row) => ({
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      displayName: row.display_name,
      summary: row.summary,
      visibility: row.visibility,
      mainMediaId: row.main_media_id,
      mediaCount: Number(row.media_count),
      updatedAt: row.updated_at.toISOString(),
    })),
    pagination: paginate(query.page, query.pageSize, Number(counts[0]?.total)),
  };
}

export async function getAdminVm(pool: Pool, vm: VmIdentity): Promise<AdminVmDetail | null> {
  const [rows] = await pool.execute<AdminVmRow[]>(
    `SELECT ${ADMIN_VM_COLUMNS}, vm.description,
       (SELECT COUNT(*) FROM vm_versions AS version
         WHERE version.emulator_type = vm.emulator_type AND version.vm_name = vm.vm_name)
         AS version_count
     FROM virtual_machines AS vm
     ${ADMIN_VM_JOIN}
     WHERE vm.emulator_type = ? AND vm.vm_name = ?`,
    [vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    displayName: row.display_name,
    description: row.description,
    visibility: row.visibility,
    mainMediaId: row.main_media_id,
    mediaCount: Number(row.media_count),
    versionCount: Number(row.version_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Returns whether the VM exists. Only the fields present in the request change. */
export async function updateVmMetadata(
  pool: Pool,
  vm: VmIdentity,
  changes: UpdateVmMetadataRequest,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  if (changes.displayName !== undefined) {
    assignments.push('display_name = ?');
    values.push(changes.displayName);
  }
  if (changes.description !== undefined) {
    assignments.push('description = ?');
    values.push(changes.description === '' ? null : changes.description);
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE virtual_machines SET ${assignments.join(', ')}
     WHERE emulator_type = ? AND vm_name = ?`,
    [...values, vm.emulatorType, vm.vmName],
  );
  return result.affectedRows > 0;
}

export async function setVmVisibility(
  pool: Pool,
  vm: VmIdentity,
  visibility: VmVisibility,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE virtual_machines SET visibility = ? WHERE emulator_type = ? AND vm_name = ?',
    [visibility, vm.emulatorType, vm.vmName],
  );
  return result.affectedRows > 0;
}

interface AdminMediaRow extends RowDataPacket {
  id: string;
  visibility: MediaVisibility;
  is_main: number;
  original_filename: string;
  original_size_bytes: number;
  width_px: number;
  height_px: number;
  captured_at: Date | null;
  created_at: Date;
  shown_as_public_main: number;
}

export async function vmExists(executor: Pool | PoolConnection, vm: VmIdentity): Promise<boolean> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
    [vm.emulatorType, vm.vmName],
  );
  return rows.length > 0;
}

export async function listAdminMedia(pool: Pool, vm: VmIdentity): Promise<AdminMedia[]> {
  const [rows] = await pool.execute<AdminMediaRow[]>(
    `SELECT media.id, media.visibility, media.is_main, media.original_filename,
            media.original_size_bytes, media.width_px, media.height_px, media.captured_at,
            media.created_at, card.media_id IS NOT NULL AS shown_as_public_main
     FROM vm_media AS media
     LEFT JOIN public_catalog_card_media AS card ON card.media_id = media.id
     WHERE media.emulator_type = ? AND media.vm_name = ?
     ORDER BY media.is_main DESC, COALESCE(media.captured_at, media.created_at), media.id`,
    [vm.emulatorType, vm.vmName],
  );
  return rows.map((row) => ({
    id: row.id,
    visibility: row.visibility,
    isMain: Boolean(row.is_main),
    originalFilename: row.original_filename,
    originalSizeBytes: Number(row.original_size_bytes),
    widthPx: row.width_px,
    heightPx: row.height_px,
    capturedAt: row.captured_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    shownAsPublicMain: Boolean(row.shown_as_public_main),
  }));
}

export async function setMediaVisibility(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
  visibility: MediaVisibility,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE vm_media SET visibility = ? WHERE id = ? AND emulator_type = ? AND vm_name = ?',
    [visibility, mediaId, vm.emulatorType, vm.vmName],
  );
  return result.affectedRows > 0;
}

/**
 * Locks the VM row first. Every change to a VM's main selection or its media rows goes through this
 * one lock, so concurrent changes run one at a time and always take locks in the same order.
 */
async function lockVm(connection: PoolConnection, vm: VmIdentity): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ? FOR UPDATE',
    [vm.emulatorType, vm.vmName],
  );
  if (rows.length === 0) throw new CatalogNotFoundError('vm');
}

/**
 * Selects a main image. Scoping the media lookup to this VM is what makes a cross-VM selection
 * impossible. The old flag is cleared first because the unique index allows only one main per VM.
 * Selecting private media is allowed: the public catalog keeps showing the placeholder until it is
 * published.
 */
export async function selectMainMedia(pool: Pool, vm: VmIdentity, mediaId: string): Promise<void> {
  await withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    const [media] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM vm_media WHERE id = ? AND emulator_type = ? AND vm_name = ?',
      [mediaId, vm.emulatorType, vm.vmName],
    );
    if (media.length === 0) throw new CatalogNotFoundError('media');
    await connection.execute(
      'UPDATE vm_media SET is_main = FALSE WHERE emulator_type = ? AND vm_name = ? AND is_main AND id <> ?',
      [vm.emulatorType, vm.vmName, mediaId],
    );
    await connection.execute('UPDATE vm_media SET is_main = TRUE WHERE id = ?', [mediaId]);
  });
}

/** Nothing is promoted in its place: with no main image, the public catalog shows the placeholder. */
export async function clearMainMedia(pool: Pool, vm: VmIdentity): Promise<void> {
  await withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    await connection.execute(
      'UPDATE vm_media SET is_main = FALSE WHERE emulator_type = ? AND vm_name = ? AND is_main',
      [vm.emulatorType, vm.vmName],
    );
  });
}

/**
 * Deletes a media item and its files as one unit, as far as a database and a filesystem can be.
 *
 * The row is removed inside a transaction, then the files, and only then does it commit. If removing
 * a file fails, the transaction rolls back and the row survives, so the item is still listed and the
 * delete can be retried (removal ignores files that are already gone). The opposite order could
 * leave files nothing refers to, which nobody could then find or remove.
 *
 * A file another row still refers to is left alone.
 */
export async function deleteMedia(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
  removeFile: (key: string) => Promise<void>,
): Promise<void> {
  await withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT original_key, jpeg_key, thumbnail_key FROM vm_media
       WHERE id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
      [mediaId, vm.emulatorType, vm.vmName],
    );
    const row = rows[0];
    if (!row) throw new CatalogNotFoundError('media');
    await connection.execute('DELETE FROM vm_media WHERE id = ?', [mediaId]);

    const keys = [row.original_key, row.jpeg_key, row.thumbnail_key].filter(
      (key): key is string => typeof key === 'string',
    );
    for (const key of new Set(keys)) {
      const [others] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM vm_media WHERE jpeg_key = ? OR thumbnail_key = ? OR original_key = ? LIMIT 1',
        [key, key, key],
      );
      if (others.length === 0) await removeFile(key);
    }
  });
}

export async function adminSummary(pool: Pool): Promise<AdminSummaryResponse> {
  const [vms] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(visibility = 'public'), 0) AS public_count
     FROM virtual_machines`,
  );
  const [media] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(visibility = 'published'), 0) AS published_count
     FROM vm_media`,
  );
  const vmTotal = Number(vms[0]?.total);
  const vmPublic = Number(vms[0]?.public_count);
  const mediaTotal = Number(media[0]?.total);
  const mediaPublished = Number(media[0]?.published_count);
  return {
    vms: { total: vmTotal, public: vmPublic, private: vmTotal - vmPublic },
    media: { total: mediaTotal, published: mediaPublished, private: mediaTotal - mediaPublished },
  };
}
