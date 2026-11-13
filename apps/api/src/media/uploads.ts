import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaUploadResponse, VmIdentity } from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';
import { ApiError } from '../errors.js';
import {
  cleanStaging,
  listMediaKeys,
  newMediaKey,
  type MediaStorage,
} from '../storage/media-storage.js';
import { ImageRejectedError, ImageTimeoutError, processImage } from './process.js';

export interface MediaPolicy {
  maxUploadBytes: number;
  maxPixels: number;
  maxDimension: number;
  maxConcurrentUploads: number;
  processingTimeoutSeconds: number;
  /** A connection that sends nothing for this long is treated as gone. */
  uploadIdleTimeoutMs: number;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = {
  maxUploadBytes: 64 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxDimension: 16_384,
  maxConcurrentUploads: 4,
  processingTimeoutSeconds: 30,
  uploadIdleTimeoutMs: 60_000,
};

/**
 * Answers 404 for an unregistered VM and 403 for one that belongs to another agent. A row in
 * `agent_vm_state` exists only for an agent that registered the VM or holds a copy of it, so this is
 * the existing association, and neither fact comes from the request.
 */
export async function requireCaptureUpload(
  executor: Pool | PoolConnection,
  agentId: string,
  vm: VmIdentity,
  id: string,
  hash: string,
): Promise<void> {
  // The first report or upload binds the operation to one digest. A capture is not a reusable grant
  // to upload arbitrary content after its temporary workspace disappears.
  await executor.execute(
    'UPDATE qemu_captures c JOIN agents a ON a.id = c.agent_id SET c.sha256 = COALESCE(c.sha256, ?) WHERE c.id = ? AND c.agent_id = ? AND c.emulator_type = ? AND c.vm_name = ? AND a.revoked_at IS NULL AND (c.sha256 IS NULL OR c.sha256 = ?)',
    [hash, id, agentId, vm.emulatorType, vm.vmName, hash],
  );
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT c.id FROM qemu_captures c JOIN agents a ON a.id = c.agent_id WHERE c.id = ? AND c.agent_id = ? AND c.emulator_type = ? AND c.vm_name = ? AND a.revoked_at IS NULL AND (c.sha256 IS NULL OR c.sha256 = ?)',
    [id, agentId, vm.emulatorType, vm.vmName, hash],
  );
  if (!rows[0])
    throw new ApiError(
      403,
      'capture_not_assigned',
      'This capture does not belong to this agent and VM',
    );
}

export async function requireAgentVm(pool: Pool, agentId: string, vm: VmIdentity): Promise<void> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT state.agent_id
     FROM virtual_machines AS vm
     LEFT JOIN agent_vm_state AS state
       ON state.emulator_type = vm.emulator_type AND state.vm_name = vm.vm_name
      AND state.agent_id = ?
     WHERE vm.emulator_type = ? AND vm.vm_name = ?`,
    [agentId, vm.emulatorType, vm.vmName],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, 'vm_not_registered', 'This VM is not registered');
  if (!row.agent_id) throw new ApiError(403, 'vm_not_assigned', 'This VM is not this agent’s');
}

/** The VMs an agent should watch. One whose local copy it has removed is not among them. */
export async function agentMediaVms(pool: Pool, agentId: string): Promise<VmIdentity[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT emulator_type, vm_name FROM agent_vm_state
     WHERE agent_id = ? AND execution_state <> 'absent'
     ORDER BY emulator_type, vm_name`,
    [agentId],
  );
  return rows.map((row) => ({
    emulatorType: row.emulator_type as VmIdentity['emulatorType'],
    vmName: row.vm_name as string,
  }));
}

export async function acknowledgedHashes(
  pool: Pool,
  vm: VmIdentity,
  hashes: readonly string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const placeholders = hashes.map(() => '?').join(', ');
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT original_sha256 FROM vm_media
     WHERE emulator_type = ? AND vm_name = ? AND original_sha256 IN (${placeholders})`,
    [vm.emulatorType, vm.vmName, ...hashes],
  );
  return rows.map((row) => row.original_sha256 as string);
}

async function findExisting(
  executor: Pool | PoolConnection,
  vm: VmIdentity,
  sha256: string,
): Promise<string | null> {
  const [rows] = await executor.execute<RowDataPacket[]>(
    'SELECT id FROM vm_media WHERE emulator_type = ? AND vm_name = ? AND original_sha256 = ?',
    [vm.emulatorType, vm.vmName, sha256],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

function isDuplicateEntry(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

/** Counts how many uploads are running. There is no waiting: a busy server says so, and agents retry. */
export class UploadGate {
  private running = 0;

  constructor(private readonly limit: number) {}

  tryEnter(): boolean {
    if (this.running >= this.limit) return false;
    this.running += 1;
    return true;
  }

  leave(): void {
    this.running -= 1;
  }
}

export interface UploadRequest {
  agentId: string;
  vm: VmIdentity;
  declaredSha256: string;
  sourcePath: string;
  capturedAt: Date | null;
  captureId?: string;
  body: Readable;
}

export interface UploadOutcome extends MediaUploadResponse {
  sizeBytes: number;
}

/**
 * Streams a body to a staged file, measuring and hashing it. A body over the limit stops at once, and a
 * connection that goes quiet or drops ends this with an error, which leaves nothing but the staged file
 * for the caller to remove.
 */
async function receive(
  body: Readable,
  stagedPath: string,
  policy: MediaPolicy,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const idle = setTimeout(() => {
    body.destroy(new ApiError(408, 'upload_timeout', 'The upload stopped sending data'));
  }, policy.uploadIdleTimeoutMs);
  idle.unref();
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      idle.refresh();
      sizeBytes += chunk.length;
      if (sizeBytes > policy.maxUploadBytes) {
        done(new ApiError(413, 'upload_too_large', 'The upload is over the size limit'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(stagedPath, { flags: 'wx' }));
  } finally {
    clearTimeout(idle);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * Takes one screenshot from a verified agent to a committed row. In order, so that every failure leaves
 * something safe:
 *
 * 1. The bytes go to staging, where nothing can serve them, and are compared with the declared hash.
 * 2. If this VM already has these bytes, that row is the answer. Nothing else happens.
 * 3. The image is examined and converted, still in staging.
 * 4. The three files are published under new UUID-based names, which no other upload can collide with.
 * 5. A transaction holding the VM's row lock adds the row. A row therefore never refers to a file that
 *    is not there, and the database's unique key decides who wins a race between identical uploads. The
 *    loser removes its own files, and answers with the winner's row.
 *
 * A crash between 4 and 5 leaves orphans that nothing refers to and nothing can serve. They are reported
 * at startup, and never removed automatically: see docs/media.md.
 */
export async function storeUpload(
  pool: Pool,
  storage: MediaStorage,
  policy: MediaPolicy,
  request: UploadRequest,
): Promise<UploadOutcome> {
  const { agentId, vm, declaredSha256, sourcePath, capturedAt, body, captureId } = request;
  const staged = await storage.stagingPath('.upload');
  const stagedFull = `${staged}.full.jpg`;
  const stagedThumbnail = `${staged}.thumb.jpg`;
  const published: string[] = [];
  const removeStaged = () =>
    Promise.all(
      [staged, stagedFull, stagedThumbnail].map((path) =>
        rm(path, { force: true }).catch(() => undefined),
      ),
    );
  const removePublished = () =>
    Promise.all(published.map((key) => storage.remove(key).catch(() => undefined)));

  try {
    const { sha256, sizeBytes } = await receive(body, staged, policy);
    if (sizeBytes === 0) throw new ApiError(422, 'invalid_image', 'The upload is empty');
    if (sha256 !== declaredSha256) {
      throw new ApiError(422, 'hash_mismatch', 'These bytes do not have the declared hash');
    }

    const existing = await findExisting(pool, vm, sha256);
    if (existing) return { mediaId: existing, sha256, created: false, sizeBytes };

    let image;
    try {
      image = await processImage(staged, stagedFull, stagedThumbnail, {
        maxPixels: policy.maxPixels,
        maxDimension: policy.maxDimension,
        timeoutSeconds: policy.processingTimeoutSeconds,
        maxInputBytes: policy.maxUploadBytes,
      });
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        throw new ApiError(
          error.code === 'unsupported_image' ? 415 : 422,
          error.code,
          error.message,
        );
      }
      if (error instanceof ImageTimeoutError) {
        throw new ApiError(503, 'processing_timeout', error.message);
      }
      throw error;
    }

    const mediaId = randomUUID();
    const originalKey = newMediaKey('media/originals', mediaId, image.extension);
    const jpegKey = newMediaKey('media/full', mediaId, 'jpg');
    const thumbnailKey = newMediaKey('media/thumbnails', mediaId, 'jpg');

    try {
      await storage.publish(staged, originalKey);
      published.push(originalKey);
      await storage.publish(stagedFull, jpegKey);
      published.push(jpegKey);
      await storage.publish(stagedThumbnail, thumbnailKey);
      published.push(thumbnailKey);

      const winner = await withTransaction(pool, async (connection) => {
        // The same lock, in the same order, as every other change to this VM's media.
        await connection.execute(
          'SELECT 1 FROM virtual_machines WHERE emulator_type = ? AND vm_name = ? FOR UPDATE',
          [vm.emulatorType, vm.vmName],
        );
        const [allowed] = await connection.execute<RowDataPacket[]>(
          `SELECT 1 FROM agent_vm_state AS state
           JOIN agents AS a ON a.id = state.agent_id
           WHERE state.emulator_type = ? AND state.vm_name = ? AND state.agent_id = ?
             AND a.revoked_at IS NULL`,
          [vm.emulatorType, vm.vmName, agentId],
        );
        // A revocation can arrive while the bytes are still on their way.
        if (captureId) await requireCaptureUpload(connection, agentId, vm, captureId, sha256);
        if (!captureId && allowed.length === 0) {
          throw new ApiError(403, 'vm_not_assigned', 'This agent may no longer upload to this VM');
        }
        const again = await findExisting(connection, vm, sha256);
        if (again) return again;
        await connection.execute(
          `INSERT INTO vm_media
             (id, emulator_type, vm_name, original_filename, original_sha256, original_size_bytes,
              original_key, original_mime, jpeg_key, thumbnail_key, width_px, height_px, captured_at,
              uploaded_by_agent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            mediaId,
            vm.emulatorType,
            vm.vmName,
            sourcePath,
            sha256,
            sizeBytes,
            originalKey,
            image.mimeType,
            jpegKey,
            thumbnailKey,
            image.widthPx,
            image.heightPx,
            capturedAt,
            agentId,
          ],
        );
        return null;
      });
      if (winner) {
        await removePublished();
        return { mediaId: winner, sha256, created: false, sizeBytes };
      }
      return { mediaId, sha256, created: true, sizeBytes };
    } catch (error) {
      await removePublished();
      if (isDuplicateEntry(error)) {
        const row = await findExisting(pool, vm, sha256);
        if (row) return { mediaId: row, sha256, created: false, sizeBytes };
      }
      throw error;
    }
  } finally {
    await removeStaged();
  }
}

const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Tidies up after a crash, once, at startup. Staged files were never visible, so old ones can simply go.
 * Published files without a row are only counted: a database restored from a backup would make good files
 * look like orphans, and deleting private originals on that evidence is not worth saving the space.
 */
export async function maintainMediaStorage(
  pool: Pool,
  root: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const removed = await cleanStaging(root, STAGING_MAX_AGE_MS);
  if (removed > 0) log.info({ removed }, 'Removed interrupted uploads from media staging');
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT original_key, jpeg_key, thumbnail_key FROM vm_media',
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const key of [row.original_key, row.jpeg_key, row.thumbnail_key]) {
      if (typeof key === 'string') referenced.add(key);
    }
  }
  const orphans = (await listMediaKeys(root)).filter((key) => !referenced.has(key));
  if (orphans.length > 0) {
    log.warn({ orphans: orphans.length }, 'Media files with no database row. See docs/media.md');
  }
}
