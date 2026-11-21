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
  type Pagination,
  type PublicCatalogQuery,
  type PublicCoverStatus,
  type PublicMedia,
  type PublicVmCard,
  type PublicVmDetail,
  type UpdateVmMetadataRequest,
  type ReorderMediaRequest,
  type Tag,
  tagSearchTerm,
  type VmIdentity,
  type VmVisibility,
} from '@emucat/contracts';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';
import { ApiError } from '../errors.js';
import { tagsOfVmMedia, tagsOfVms, vmKey } from './tags.js';

/**
 * All catalog SQL. Queries name every column they read, and the mappers below build each response
 * field by field, so a column added to a table later cannot reach a response by accident.
 *
 * Public queries read card images only through `public_catalog_card_media`, and media files only
 * after checking that their VM is public. Publication is decided by the VM alone (decision 0036):
 * `vm_media.visibility` is a legacy column that no query here reads or writes.
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
/** Every gallery's order: an administrator's, then the ID, so that it is total and stable (decision 0050). */
const MEDIA_ORDER = 'media.sort_order, media.id';

interface Filter {
  clause: string;
  values: string[];
}

/** LIKE has its own metacharacters. A search for `50%` must mean that text, not a pattern. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Tags that make a VM match a search: its own, its screenshots', and for administrators its versions'. A child's
 * tag finds the parent VM without becoming the VM's tag. EXISTS keeps one row per VM however many children match.
 * The public query has already required a public VM, and every screenshot of a public VM is public; versions are
 * administrative (decision 0039), so their tags never reach a public search. A version that is deleted, or being
 * deleted, no longer counts.
 */
function tagMatch(scope: CatalogScope, operator: '=' | 'LIKE'): { clause: string; count: number } {
  const own = `EXISTS (SELECT 1 FROM vm_tags AS vt JOIN tags AS tag ON tag.id = vt.tag_id
      WHERE vt.emulator_type = vm.emulator_type AND vt.vm_name = vm.vm_name
        AND tag.normalized_name ${operator} ?)`;
  const media = `EXISTS (SELECT 1 FROM vm_media_tags AS mt JOIN tags AS tag ON tag.id = mt.tag_id
      WHERE mt.emulator_type = vm.emulator_type AND mt.vm_name = vm.vm_name
        AND tag.normalized_name ${operator} ?)`;
  const versions = `EXISTS (SELECT 1 FROM vm_version_tags AS xt JOIN tags AS tag ON tag.id = xt.tag_id
      WHERE xt.emulator_type = vm.emulator_type AND xt.vm_name = vm.vm_name
        AND tag.normalized_name ${operator} ?
        AND NOT EXISTS (SELECT 1 FROM vm_version_deletions AS d WHERE d.version_id = xt.version_id))`;
  const parts = scope === 'admin' ? [own, media, versions] : [own, media];
  return { clause: parts.join(' OR '), count: parts.length };
}

type CatalogScope = 'public' | 'admin';

function catalogFilter(
  query: {
    q?: string | undefined;
    emulatorType?: EmulatorType | undefined;
    visibility?: VmVisibility | undefined;
  },
  scope: CatalogScope,
): Filter {
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
    const tag = tagSearchTerm(query.q);
    if (tag?.tagOnly) {
      // `#retro` asks for that tag, exactly, and nothing else.
      const match = tagMatch(scope, '=');
      conditions.push(`(${match.clause})`);
      values.push(...Array<string>(match.count).fill(tag.term));
    } else {
      const pattern = likePattern(query.q);
      const text = `vm.display_name LIKE ? OR ${VM_NAME_TEXT} LIKE ? OR vm.description LIKE ?`;
      if (tag) {
        const match = tagMatch(scope, 'LIKE');
        conditions.push(`(${text} OR ${match.clause})`);
        values.push(
          pattern,
          pattern,
          pattern,
          ...Array<string>(match.count).fill(likePattern(tag.term)),
        );
      } else {
        conditions.push(`(${text})`);
        values.push(pattern, pattern, pattern);
      }
    }
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

function identityOf(row: { emulator_type: EmulatorType; vm_name: string }): VmIdentity {
  return { emulatorType: row.emulator_type, vmName: row.vm_name };
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
  const filter = catalogFilter({ ...query, visibility: 'public' }, 'public');
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
  const tags = await tagsOfVms(pool, rows.map(identityOf));
  return {
    items: rows.map((row) => ({
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      displayName: row.display_name,
      summary: row.summary,
      mainImage: publicImage(row),
      tags: tags.get(vmKey(identityOf(row))) ?? [],
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
  // The VM is checked again here, so that the gallery can never outlive a VM made private meanwhile.
  const [gallery] = await pool.execute<RowDataPacket[]>(
    `SELECT media.id, media.width_px, media.height_px
     FROM vm_media AS media
     JOIN virtual_machines AS vm
       ON vm.emulator_type = media.emulator_type AND vm.vm_name = media.vm_name
     WHERE vm.visibility = 'public' AND media.emulator_type = ? AND media.vm_name = ?
     ORDER BY ${MEDIA_ORDER}`,
    [vm.emulatorType, vm.vmName],
  );
  // Read only once the VM is known to be public: these are the tags of public things.
  const vmTags = await tagsOfVms(pool, [identityOf(row)]);
  const mediaTags = gallery.length > 0 ? await tagsOfVmMedia(pool, vm) : new Map<string, Tag[]>();
  return {
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    displayName: row.display_name,
    description: row.description,
    mainImage: publicImage(row),
    tags: vmTags.get(vmKey(identityOf(row))) ?? [],
    gallery: gallery.map((item) => ({
      id: item.id as string,
      widthPx: item.width_px as number,
      heightPx: item.height_px as number,
      tags: mediaTags.get(item.id as string) ?? [],
    })),
  };
}

function storageKeyColumn(variant: MediaVariant): 'jpeg_key' | 'thumbnail_key' {
  return variant === 'full' ? 'jpeg_key' : 'thumbnail_key';
}

/**
 * The storage key of a JPEG derivative the public may see, or `null` for anything else. Only the
 * thumbnail and the full JPEG of a public VM's media qualify: never an original, and never anything
 * that is not media.
 */
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
     WHERE media.id = ? AND vm.visibility = 'public'`,
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
  /** Only in the list, which shows a running badge. */
  active_sessions?: number | string;
  created_at: Date;
  updated_at: Date;
}

/** The same rule as the `public_catalog_card_media` view, stated as a reason. */
function publicCover(row: AdminVmRow): PublicCoverStatus {
  if (row.visibility !== 'public') return 'vm_private';
  return row.main_media_id ? 'shown' : 'no_main_image';
}

export async function listAdminVms(
  pool: Pool,
  query: AdminCatalogQuery,
): Promise<{ items: AdminVmCard[]; pagination: Pagination }> {
  const filter = catalogFilter(query, 'admin');
  const [counts] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM virtual_machines AS vm ${filter.clause}`,
    filter.values,
  );
  const [rows] = await pool.execute<AdminVmRow[]>(
    `SELECT ${ADMIN_VM_COLUMNS}, LEFT(vm.description, ${CATALOG_SUMMARY_LENGTH}) AS summary,
       (SELECT COUNT(*) FROM vm_sessions AS session
         WHERE session.emulator_type = vm.emulator_type AND session.vm_name = vm.vm_name
           AND session.active_marker = 1) AS active_sessions
     FROM virtual_machines AS vm
     ${ADMIN_VM_JOIN}
     ${filter.clause}
     ORDER BY ${TITLE_ORDER}
     ${limitClause(query.page, query.pageSize)}`,
    filter.values,
  );
  const tags = await tagsOfVms(pool, rows.map(identityOf));
  return {
    items: rows.map((row) => ({
      emulatorType: row.emulator_type,
      vmName: row.vm_name,
      displayName: row.display_name,
      summary: row.summary,
      visibility: row.visibility,
      mainMediaId: row.main_media_id,
      publicCover: publicCover(row),
      mediaCount: Number(row.media_count),
      activeSessions: Number(row.active_sessions ?? 0),
      tags: tags.get(vmKey(identityOf(row))) ?? [],
      updatedAt: row.updated_at.toISOString(),
    })),
    pagination: paginate(query.page, query.pageSize, Number(counts[0]?.total)),
  };
}

export async function getAdminVm(pool: Pool, vm: VmIdentity): Promise<AdminVmDetail | null> {
  const [rows] = await pool.execute<AdminVmRow[]>(
    `SELECT ${ADMIN_VM_COLUMNS}, vm.description,
       (SELECT COUNT(*) FROM vm_versions AS version
         WHERE version.emulator_type = vm.emulator_type AND version.vm_name = vm.vm_name
           AND NOT EXISTS (SELECT 1 FROM vm_version_deletions AS deletion
             WHERE deletion.version_id = version.id))
         AS version_count
     FROM virtual_machines AS vm
     ${ADMIN_VM_JOIN}
     WHERE vm.emulator_type = ? AND vm.vm_name = ?`,
    [vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  if (!row) return null;
  const tags = await tagsOfVms(pool, [identityOf(row)]);
  return {
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    displayName: row.display_name,
    description: row.description,
    visibility: row.visibility,
    mainMediaId: row.main_media_id,
    publicCover: publicCover(row),
    mediaCount: Number(row.media_count),
    versionCount: Number(row.version_count),
    tags: tags.get(vmKey(identityOf(row))) ?? [],
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
    `SELECT media.id, media.is_main, media.original_filename,
            media.original_size_bytes, media.width_px, media.height_px, media.captured_at,
            media.created_at, card.media_id IS NOT NULL AS shown_as_public_main
     FROM vm_media AS media
     LEFT JOIN public_catalog_card_media AS card ON card.media_id = media.id
     WHERE media.emulator_type = ? AND media.vm_name = ?
     ORDER BY ${MEDIA_ORDER}`,
    [vm.emulatorType, vm.vmName],
  );
  const tags = rows.length > 0 ? await tagsOfVmMedia(pool, vm) : new Map<string, Tag[]>();
  return rows.map((row) => ({
    id: row.id,
    isMain: Boolean(row.is_main),
    originalFilename: row.original_filename,
    originalSizeBytes: Number(row.original_size_bytes),
    widthPx: row.width_px,
    heightPx: row.height_px,
    capturedAt: row.captured_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    shownAsPublicMain: Boolean(row.shown_as_public_main),
    tags: tags.get(row.id) ?? [],
  }));
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
 * Selecting the main image changes only which image is the cover, never who may see it: that is
 * the VM's visibility alone.
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
 * Deletes a media item from the catalog, and its files, as one unit as far as a database and a filesystem can be.
 *
 * The row is removed inside a transaction, then the files, and only then does it commit. If removing a file
 * fails, the transaction rolls back and the row survives, so the item is still listed and the delete can be
 * retried (removal ignores files that are already gone). The opposite order could leave files nothing refers
 * to, which nobody could then find or remove. A file another row still refers to is left alone.
 *
 * The same transaction records a suppression of these bytes for this VM (decision 0050), so that the agent,
 * which still has the file, does not bring the screenshot back: see `acknowledgedHashes` and `storeUpload`.
 * The item's tags go with its row, and so does the main selection: nothing is promoted in its place. The
 * remaining screenshots keep their positions, gaps and all, so their order does not change.
 */
export async function deleteMedia(
  pool: Pool,
  vm: VmIdentity,
  mediaId: string,
  removeFile: (key: string) => Promise<void>,
  deletedByUserId: string | null = null,
): Promise<void> {
  await withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT original_key, jpeg_key, thumbnail_key, original_sha256, original_filename FROM vm_media
       WHERE id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
      [mediaId, vm.emulatorType, vm.vmName],
    );
    const row = rows[0];
    if (!row) throw new CatalogNotFoundError('media');
    await connection.execute('DELETE FROM vm_media WHERE id = ?', [mediaId]);
    await connection.execute(
      `INSERT INTO vm_media_suppressions
         (emulator_type, vm_name, original_sha256, media_id, original_filename, deleted_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE media_id = VALUES(media_id),
         original_filename = VALUES(original_filename),
         deleted_by_user_id = VALUES(deleted_by_user_id), deleted_at = CURRENT_TIMESTAMP(3)`,
      [
        vm.emulatorType,
        vm.vmName,
        row.original_sha256 as string,
        mediaId,
        row.original_filename as string,
        deletedByUserId,
      ],
    );

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

/**
 * Puts a VM's screenshots in this order, first to last, in one transaction under the VM's row lock. The list
 * must be exactly the VM's screenshots, each once: a screenshot that arrived or was deleted since the order was
 * made makes it stale, and it is refused with 409 rather than guessed at. Nothing else changes, the main image
 * included.
 */
export async function reorderMedia(
  pool: Pool,
  vm: VmIdentity,
  { mediaIds }: ReorderMediaRequest,
): Promise<void> {
  await withTransaction(pool, async (connection) => {
    await lockVm(connection, vm);
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM vm_media WHERE emulator_type = ? AND vm_name = ?',
      [vm.emulatorType, vm.vmName],
    );
    const current = new Set(rows.map((row) => (row.id as string).toLowerCase()));
    const requested = mediaIds.map((id) => id.toLowerCase());
    if (requested.length !== current.size || requested.some((id) => !current.has(id))) {
      throw new ApiError(
        409,
        'media_order_conflict',
        'The screenshots changed since this order was made. Reload them and try again',
      );
    }
    // One statement, whatever the count: CASE over the positions, in chunks to keep each statement small.
    const CHUNK = 500;
    for (let start = 0; start < requested.length; start += CHUNK) {
      const chunk = requested.slice(start, start + CHUNK);
      const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
      const placeholders = chunk.map(() => '?').join(', ');
      await connection.execute(
        `UPDATE vm_media SET sort_order = CASE id ${cases} END
         WHERE emulator_type = ? AND vm_name = ? AND id IN (${placeholders})`,
        [
          ...chunk.flatMap((id, index) => [id, start + index + 1]),
          vm.emulatorType,
          vm.vmName,
          ...chunk,
        ],
      );
    }
  });
}

export async function adminSummary(pool: Pool): Promise<AdminSummaryResponse> {
  const [vms] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(visibility = 'public'), 0) AS public_count
     FROM virtual_machines`,
  );
  const [media] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(vm.visibility = 'public'), 0) AS public_count
     FROM vm_media AS media
     JOIN virtual_machines AS vm
       ON vm.emulator_type = media.emulator_type AND vm.vm_name = media.vm_name`,
  );
  const vmTotal = Number(vms[0]?.total);
  const vmPublic = Number(vms[0]?.public_count);
  const mediaTotal = Number(media[0]?.total);
  const mediaPublic = Number(media[0]?.public_count);
  return {
    vms: { total: vmTotal, public: vmPublic, private: vmTotal - vmPublic },
    media: { total: mediaTotal, public: mediaPublic, private: mediaTotal - mediaPublic },
  };
}
