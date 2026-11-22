import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveFormatFor, type RegistrationProgressPayload } from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  ArchiveCheckError,
  DEFAULT_ARCHIVE_LIMITS,
  MANIFEST_ENTRY_NAME,
  canonicalManifestBytes,
  inspectZip,
  sha256Hex,
  type ArchiveLimits,
} from '../archives/manifest.js';
import { checkOvaLayout, readTar, TarFormatError } from '../archives/tar.js';
import {
  hashEntry,
  isDirectoryName,
  openLocal,
  rewriteZip,
  ZipFormatError,
} from '../archives/zip.js';
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import { repositoryRecord } from '../registration/repositories.js';
import {
  RepositoryAccessError,
  type RepositoryAccess,
  type RepositorySession,
} from '../repository-access/ssh.js';
import { StagingBusyError, StagingFullError, type StagingArea } from '../transfers/staging.js';

/**
 * Server-side clones (decision 0055). A clone is a registration operation with no agent (`agent_id IS NULL`): this
 * runner does what an agent's clone does (decision 0052), over the server's own repository connection, in its own
 * staging directory, and reports through the registration coordinator, which commits it exactly as an agent's.
 *
 * 1. The source archive is downloaded and must be the registered bytes (size and SHA-256).
 * 2. A ZIP is inspected as a restore would, rewritten with the new VM's name in its manifest and every other entry
 *    copied raw, then checked again and every file decompressed and hashed against the manifest. An OVA is checked
 *    as a TAR with one descriptor first and copied byte for byte.
 * 3. The clone is uploaded to the operation's staging key, read back and compared, and published with a no-overwrite
 *    hard link. Only then is it committed.
 *
 * The source is only ever read. A restart fails nothing that can be resumed: an interrupted clone runs again from
 * the start, a limited number of times (`server_attempts`), and one that was already committing is committed.
 */

const ACTIVE = ['queued', 'validating', 'archiving', 'uploading', 'verifying', 'committing'];

export interface ServerCloneOptions {
  /** How often a clone is started again after the server restarted during it. */
  maxAttempts: number;
  /** How often an upload is tried within one run. */
  uploadAttempts: number;
  limits: ArchiveLimits;
  /** How often progress is written, at most. */
  progressIntervalMs: number;
}

export const DEFAULT_SERVER_CLONE_OPTIONS: ServerCloneOptions = {
  maxAttempts: 3,
  uploadAttempts: 3,
  limits: DEFAULT_ARCHIVE_LIMITS,
  progressIntervalMs: 1000,
};

class CloneFailure extends Error {
  override readonly name = 'CloneFailure';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (code: string, message: string) => new CloneFailure(code, message);

function toFailure(error: unknown): CloneFailure {
  if (error instanceof CloneFailure) return error;
  if (error instanceof RepositoryAccessError) return fail(error.code, `${error.message}.`);
  if (error instanceof StagingFullError || error instanceof StagingBusyError) {
    return fail(error.code, error.message);
  }
  if (
    error instanceof ArchiveCheckError ||
    error instanceof ZipFormatError ||
    error instanceof TarFormatError
  ) {
    return fail('source_archive_invalid', `The source archive was refused: ${error.message}.`);
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') {
    return fail(
      'insufficient_staging_space',
      'The server’s staging disk filled up during the clone.',
    );
  }
  if ((error as Error).name === 'AbortError' || code === 'ABORT_ERR') {
    return fail('cancelled', 'Cancelled by an administrator.');
  }
  return fail(
    'internal_error',
    'The server could not complete the clone. Its log has the details.',
  );
}

interface CloneRow {
  id: string;
  state: string;
  repositoryId: string;
  emulatorType: 'qemu' | '86box' | 'virtualbox';
  vmName: string;
  versionId: string;
  archiveKey: string;
  sourceVmName: string;
  sourceArchiveKey: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  sourceManifestSha256: string | null;
  attempts: number;
}

async function hashFile(
  path: string,
  signal: AbortSignal,
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal })) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

export class ServerCloneRunner {
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly waiting: string[] = [];
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly access: RepositoryAccess,
    private readonly registrations: RegistrationCoordinator,
    private readonly staging: StagingArea,
    private readonly log: FastifyBaseLogger,
    private readonly options: ServerCloneOptions = DEFAULT_SERVER_CLONE_OPTIONS,
  ) {
    registrations.onServerCancel = (operationId) => this.cancel(operationId);
  }

  get configured(): boolean {
    return this.access.configured;
  }

  /**
   * After a restart: a clone that was committing is committed from what was recorded; any other is run again, or
   * failed once it has been interrupted too often. Directories no clone claims are removed.
   */
  async start(): Promise<void> {
    await this.staging.prepare();
    const placeholders = ACTIVE.map(() => '?').join(', ');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, state, server_attempts FROM registration_operations
       WHERE agent_id IS NULL AND mode = 'clone' AND state IN (${placeholders})
       ORDER BY created_at`,
      ACTIVE,
    );
    const claimed = new Set(rows.map((row) => row.id as string));
    for (const name of await this.staging.present('clones')) {
      if (!claimed.has(name)) await this.staging.remove('clones', name);
    }
    for (const row of rows) {
      const id = row.id as string;
      if (row.state === 'committing') {
        try {
          await this.registrations.reconcile(id);
        } catch (error) {
          this.log.error(
            { err: error, operationId: id },
            'Cannot commit a server-side clone after a restart',
          );
        }
        continue;
      }
      if (row.state !== 'queued' && Number(row.server_attempts) >= this.options.maxAttempts) {
        await this.staging.remove('clones', id);
        await this.registrations.serverFailed(
          id,
          'server_restarted',
          'The server restarted during this clone too often. Nothing was created.',
        );
        continue;
      }
      // An interrupted run starts again from the beginning, so its state does too.
      await this.pool.execute(
        `UPDATE registration_operations
         SET state = 'queued', progress_done_bytes = NULL, progress_total_bytes = NULL
         WHERE id = ? AND agent_id IS NULL AND state IN ('validating', 'archiving', 'uploading', 'verifying')`,
        [id],
      );
      this.enqueue(id);
    }
  }

  /** Starts a clone now if a slot is free, or once one is. */
  enqueue(operationId: string): void {
    if (this.closed || this.running.has(operationId) || this.waiting.includes(operationId)) return;
    this.waiting.push(operationId);
    this.pump();
  }

  cancel(operationId: string): void {
    const index = this.waiting.indexOf(operationId);
    if (index >= 0) this.waiting.splice(index, 1);
    this.running.get(operationId)?.abort.abort();
  }

  isRunning(operationId: string): boolean {
    return this.running.has(operationId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.waiting.length = 0;
    const runs = [...this.running.values()];
    for (const run of runs) run.abort.abort();
    await Promise.allSettled(runs.map((run) => run.done));
  }

  private pump(): void {
    while (!this.closed && this.waiting.length > 0 && this.staging.freeSlots() > 0) {
      const operationId = this.waiting.shift() as string;
      const release = this.staging.claimSlot(operationId);
      const abort = new AbortController();
      const done = this.run(operationId, abort.signal)
        .catch((error: unknown) => {
          this.log.error({ err: error, operationId }, 'A server-side clone ended unexpectedly');
        })
        .finally(() => {
          release();
          this.running.delete(operationId);
          this.pump();
        });
      this.running.set(operationId, { abort, done });
    }
  }

  private async load(operationId: string): Promise<CloneRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, state, repository_id, emulator_type, vm_name, version_id, archive_key, clone_source_vm_name,
              clone_source_archive_key, clone_source_archive_sha256, clone_source_archive_size_bytes,
              clone_source_manifest_sha256, server_attempts, cancel_requested_at
       FROM registration_operations
       WHERE id = ? AND agent_id IS NULL AND mode = 'clone'`,
      [operationId],
    );
    const row = rows[0];
    if (!row || row.cancel_requested_at || !ACTIVE.includes(row.state as string)) return null;
    return {
      id: row.id as string,
      state: row.state as string,
      repositoryId: row.repository_id as string,
      emulatorType: row.emulator_type as CloneRow['emulatorType'],
      vmName: row.vm_name as string,
      versionId: row.version_id as string,
      archiveKey: row.archive_key as string,
      sourceVmName: row.clone_source_vm_name as string,
      sourceArchiveKey: row.clone_source_archive_key as string,
      sourceSha256: row.clone_source_archive_sha256 as string,
      sourceSizeBytes: Number(row.clone_source_archive_size_bytes),
      sourceManifestSha256: (row.clone_source_manifest_sha256 as string | null) ?? null,
      attempts: Number(row.server_attempts),
    };
  }

  private reporter(operationId: string, stage: RegistrationProgressPayload['stage']) {
    let last = 0;
    return (done: number, total: number) => {
      const now = Date.now();
      if (now - last < this.options.progressIntervalMs && done < total) return;
      last = now;
      void this.registrations
        .serverProgress(operationId, stage, done, total)
        .catch(() => undefined);
    };
  }

  private async run(operationId: string, signal: AbortSignal): Promise<void> {
    const row = await this.load(operationId);
    if (!row) return;
    // Counted before any work: a restart in the middle of this run is one more attempt.
    await this.pool.execute(
      'UPDATE registration_operations SET server_attempts = server_attempts + 1 WHERE id = ?',
      [operationId],
    );
    const stagingKey = `archives/.staging/${operationId}.part`;
    let session: RepositorySession | null = null;
    let published = false;
    let reservation: { release(): void } | null = null;
    try {
      if (!(await this.registrations.serverProgress(operationId, 'validating', null, null))) return;
      const repository = await repositoryRecord(this.pool, row.repositoryId);
      if (!repository || !repository.enabled) {
        throw fail('repository_not_authorized', 'The repository is disabled or no longer exists.');
      }
      if (!this.access.configured) {
        throw fail(
          'server_repository_unavailable',
          'This server has no repository SSH key, so it cannot clone. See the deployment guide.',
        );
      }
      session = await this.access.open(repository.endpoint, signal);
      const existing = await session.stat(row.archiveKey);
      // Only an earlier run of this same clone can have published there; it is checked against what is built.
      if (existing && row.attempts === 0) {
        throw fail('archive_exists', 'An archive already exists at the clone’s key.');
      }
      const source = await session.stat(row.sourceArchiveKey);
      if (!source) {
        throw fail(
          'remote_object_missing',
          'The source version’s archive is not in the repository.',
        );
      }
      if (source.sizeBytes !== row.sourceSizeBytes) {
        throw fail(
          'source_archive_invalid',
          'The source version’s archive does not have the registered size.',
        );
      }

      const zip = archiveFormatFor(row.emulatorType) === 'zip';
      reservation = await this.staging.reserve(
        `clone:${operationId}`,
        row.sourceSizeBytes * (zip ? 2 : 1),
      );
      await this.staging.remove('clones', operationId);
      const work = await this.staging.create('clones', operationId);
      const downloaded = join(work, zip ? 'source.zip' : 'source.ova');
      const output = join(work, zip ? 'clone.zip' : 'clone.ova');

      if (
        !(await this.registrations.serverProgress(operationId, 'archiving', 0, row.sourceSizeBytes))
      )
        return;
      const received = await session.download(
        row.sourceArchiveKey,
        downloaded,
        this.reporter(operationId, 'archiving'),
        signal,
      );
      if (received.sizeBytes !== row.sourceSizeBytes || received.sha256 !== row.sourceSha256) {
        throw fail(
          'source_archive_invalid',
          'The downloaded source archive is not the one that was registered.',
        );
      }

      const manifest = zip
        ? await this.rewrite(row, downloaded, output, signal)
        : await this.copyOva(downloaded, output);
      signal.throwIfAborted();
      const built = await hashFile(output, signal);
      if (!manifest && built.sha256 !== row.sourceSha256) {
        throw fail('hash_mismatch', 'The copied OVA differs from its source.');
      }
      const free = await session.freeSpace();
      if (free !== null && free < built.sizeBytes) {
        throw fail(
          'insufficient_remote_space',
          `The repository has ${free} bytes free, and the clone is ${built.sizeBytes} bytes.`,
        );
      }

      await this.uploadAndVerify(session, operationId, output, stagingKey, built, signal);
      signal.throwIfAborted();
      try {
        await session.publish(stagingKey, row.archiveKey);
      } catch (error) {
        if (
          !(error instanceof RepositoryAccessError) ||
          error.code !== 'archive_exists' ||
          row.attempts === 0
        ) {
          throw error;
        }
        // An earlier run of this clone published before the server stopped: only the same bytes count.
        await session
          .verify(row.archiveKey, built.sizeBytes, built.sha256, undefined, signal)
          .catch(() => {
            throw fail(
              'archive_exists',
              'An archive already exists at the clone’s key, and it is not this clone.',
            );
          });
      }
      published = true;
      await session.delete(stagingKey).catch(() => undefined);

      const outcome = await this.registrations.commitServerClone({
        operationId,
        versionId: row.versionId,
        archiveKey: row.archiveKey,
        archiveSizeBytes: built.sizeBytes,
        archiveSha256: built.sha256,
        manifest,
      });
      if (outcome.outcome === 'rejected') {
        if (outcome.deletePublished) await session.delete(row.archiveKey).catch(() => undefined);
        this.log.warn({ operationId }, 'A server-side clone was not committed');
      } else {
        this.log.info({ operationId, vmName: row.vmName }, 'Server-side clone committed');
      }
    } catch (error) {
      const failure = signal.aborted
        ? fail('cancelled', 'Cancelled by an administrator.')
        : toFailure(error);
      if (failure.code === 'internal_error') {
        this.log.error({ err: error, operationId }, 'A server-side clone failed');
      } else {
        this.log.warn({ operationId, code: failure.code }, 'A server-side clone failed');
      }
      await this.registrations.serverFailed(operationId, failure.code, failure.message);
      if (session) {
        await session.delete(stagingKey).catch(() => undefined);
        // Published but never committed: nothing refers to it.
        if (published) await session.delete(row.archiveKey).catch(() => undefined);
      }
    } finally {
      session?.close();
      reservation?.release();
      await this.staging.remove('clones', operationId).catch(() => undefined);
    }
  }

  private async uploadAndVerify(
    session: RepositorySession,
    operationId: string,
    output: string,
    stagingKey: string,
    built: { sizeBytes: number; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (
          !(await this.registrations.serverProgress(operationId, 'uploading', 0, built.sizeBytes))
        ) {
          throw fail('cancelled', 'Cancelled by an administrator.');
        }
        await session.upload(output, stagingKey, this.reporter(operationId, 'uploading'), signal);
        if (
          !(await this.registrations.serverProgress(operationId, 'verifying', 0, built.sizeBytes))
        ) {
          throw fail('cancelled', 'Cancelled by an administrator.');
        }
        await session.verify(
          stagingKey,
          built.sizeBytes,
          built.sha256,
          this.reporter(operationId, 'verifying'),
          signal,
        );
        return;
      } catch (error) {
        const retryable =
          error instanceof RepositoryAccessError &&
          (error.code === 'upload_interrupted' || error.code === 'hash_mismatch');
        if (!retryable || attempt >= this.options.uploadAttempts || signal.aborted) throw error;
        this.log.warn(
          { operationId, attempt, code: error.code },
          'Clone upload failed; trying again',
        );
        await session.delete(stagingKey).catch(() => undefined);
      }
    }
  }

  /** A ZIP: the source as a restore checks it, rewritten with the new name, then the result checked in full. */
  private async rewrite(row: CloneRow, downloaded: string, output: string, signal: AbortSignal) {
    const source = await openLocal(downloaded);
    let inspected;
    try {
      inspected = await inspectZip(
        source,
        {
          emulatorType: row.emulatorType,
          vmName: row.sourceVmName,
          manifestSha256: row.sourceManifestSha256,
        },
        this.options.limits,
      );
    } finally {
      await source.close();
    }
    const manifest = { ...inspected.manifest, vmName: row.vmName };
    const manifestBytes = canonicalManifestBytes(manifest);
    const manifestSha256 = sha256Hex(manifestBytes);
    const reportArchive = this.reporter(row.id, 'archiving');
    let written = 0;
    await rewriteZip(
      downloaded,
      output,
      MANIFEST_ENTRY_NAME,
      MANIFEST_ENTRY_NAME,
      manifestBytes,
      {
        maxEntries: this.options.limits.maxEntries,
        maxDirectoryBytes: this.options.limits.maxDirectoryBytes,
      },
      (count) => {
        written += count;
        reportArchive(written, row.sourceSizeBytes);
      },
      signal,
    );
    // Its room is needed for nothing else now.
    await rm(downloaded, { force: true });

    // The clone, checked as a restore of the new VM would check it, then every file against the manifest.
    const clone = await openLocal(output);
    try {
      const checked = await inspectZip(
        clone,
        { emulatorType: row.emulatorType, vmName: row.vmName, manifestSha256 },
        this.options.limits,
      ).catch((error: unknown) => {
        throw fail('hash_mismatch', `The written clone was refused: ${(error as Error).message}.`);
      });
      if (!checked.manifestRaw.equals(manifestBytes)) {
        throw fail('hash_mismatch', 'The written clone has another manifest.');
      }
      const listed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
      const reportVerify = this.reporter(row.id, 'archiving');
      let done = 0;
      for (const entry of checked.entries) {
        if (isDirectoryName(entry) || entry.name === MANIFEST_ENTRY_NAME) continue;
        const expected = listed.get(entry.name);
        const sha256 = await hashEntry(
          output,
          clone,
          entry,
          (count) => {
            done += count;
            reportVerify(done, manifest.totalUncompressedBytes);
          },
          signal,
        ).catch((error: unknown) => {
          if (signal.aborted) throw error;
          throw fail(
            'hash_mismatch',
            `${entry.name} cannot be read back: ${(error as Error).message}.`,
          );
        });
        if (!expected || expected.sha256 !== sha256) {
          throw fail('hash_mismatch', `${entry.name} differs from the source’s manifest.`);
        }
      }
    } finally {
      await clone.close();
    }
    return {
      manifestVersion: manifest.manifestVersion,
      manifestSha256,
      fileCount: manifest.fileCount,
      totalUncompressedBytes: manifest.totalUncompressedBytes,
    };
  }

  /** An OVA carries no EmuCat identity: checked as an OVA, then the same bytes. */
  private async copyOva(downloaded: string, output: string): Promise<null> {
    const source = await openLocal(downloaded);
    try {
      checkOvaLayout(await readTar(source));
    } finally {
      await source.close();
    }
    await rename(downloaded, output);
    return null;
  }
}
