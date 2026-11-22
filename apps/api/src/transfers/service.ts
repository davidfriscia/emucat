import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
  ChunkAck,
  RelayHealthResponse,
  RelayInfoResponse,
  RelayVerifyRequest,
  RelayVerifyStatus,
  TransferState,
  TransferStatus,
  UploadInitRequest,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import { repositoryRecord } from '../registration/repositories.js';
import {
  RepositoryAccessError,
  type RepositoryAccess,
  type RepositorySession,
} from '../repository-access/ssh.js';
import { RelayAuthorization } from './authorization.js';
import type { TransferPolicy } from './policy.js';
import { StagingFullError, type StagingArea } from './staging.js';

/**
 * The HTTPS relay (decision 0055): an agent's repository operations, carried out by the server over its own SFTP
 * connection, with the payload staged on the server's disk.
 *
 * - **Uploads** arrive in chunks of a fixed size, each checked against its own SHA-256 and recorded, so an
 *   interrupted upload resumes with the chunks that are missing. Completion checks the whole file against the
 *   declared SHA-256 and writes it to the operation's staging key in the repository; the agent then asks for it to
 *   be verified and published, exactly as over its own connection.
 * - **Downloads** are staged once per object, checked against what was registered when anything was, and read in
 *   HTTP ranges. Concurrent downloads of one object share one staged copy.
 *
 * State lives in `repository_transfers`, so a restart loses nothing but jobs in progress, which start again. One API
 * process owns the staging directory and runs every job.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATA_FILE = 'data';

interface TransferRow extends RowDataPacket {
  id: string;
  direction: 'upload' | 'download';
  state: TransferState;
  repository_id: string;
  object_key: string;
  agent_id: string | null;
  size_bytes: number | string | null;
  sha256: string | null;
  chunk_bytes: number;
  done_bytes: number | string;
  reserved_bytes: number | string;
  files_present: number;
  error_code: string | null;
  error_message: string | null;
  updated_at: Date;
  last_activity_at: Date;
}

const COLUMNS = `id, direction, state, repository_id, object_key, agent_id, size_bytes, sha256, chunk_bytes,
  done_bytes, reserved_bytes, files_present, error_code, error_message, updated_at, last_activity_at`;

const ACTIVE = ['receiving', 'received', 'publishing', 'staging', 'ready'] as const;

function chunkCountOf(size: number, chunkBytes: number): number {
  return Math.ceil(size / chunkBytes);
}

/** Missing indexes as inclusive ranges, from the sorted indexes present. */
function missingRanges(present: number[], count: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let next = 0;
  for (const index of present) {
    if (index > next) ranges.push([next, index - 1]);
    next = index + 1;
  }
  if (next < count) ranges.push([next, count - 1]);
  return ranges;
}

const notFound = () => new ApiError(404, 'transfer_not_found', 'Transfer not found');

function repositoryProblem(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RepositoryAccessError) {
    const status =
      error.code === 'archive_exists'
        ? 409
        : error.code === 'remote_object_missing'
          ? 404
          : error.code === 'server_repository_unavailable'
            ? 503
            : 502;
    return new ApiError(status, error.code, error.message);
  }
  if (error instanceof StagingFullError) return new ApiError(507, error.code, error.message);
  throw error;
}

interface VerifyJob {
  status: RelayVerifyStatus;
  touchedAt: number;
}

export class TransferService {
  readonly authorization: RelayAuthorization;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly verifications = new Map<string, VerifyJob>();
  private readonly aborts = new Map<string, AbortController>();
  private sweeper: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly access: RepositoryAccess,
    private readonly staging: StagingArea,
    private readonly policy: TransferPolicy,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.authorization = new RelayAuthorization(pool);
  }

  get enabled(): boolean {
    return this.policy.relayEnabled && this.access.configured;
  }

  // Lifecycle.

  /** After a restart: reservations are counted again, interrupted jobs start again, and unclaimed files go. */
  async start(sweepIntervalMs = 60_000): Promise<void> {
    await this.staging.prepare();
    const [rows] = await this.pool.execute<TransferRow[]>(
      `SELECT ${COLUMNS} FROM repository_transfers WHERE files_present = 1`,
    );
    const keep = new Set<string>();
    for (const row of rows) {
      if (!(ACTIVE as readonly string[]).includes(row.state)) continue;
      keep.add(row.id);
      this.staging.adopt(row.id, Number(row.reserved_bytes));
    }
    for (const name of await this.staging.present('transfers')) {
      if (!keep.has(name)) await this.staging.remove('transfers', name);
    }
    await this.pool.execute(
      `UPDATE repository_transfers SET files_present = 0, reserved_bytes = 0
       WHERE files_present = 1 AND state NOT IN ('receiving', 'received', 'publishing', 'staging', 'ready')`,
    );
    for (const row of rows) {
      if (row.state === 'publishing' || row.state === 'received') {
        await this.setState(row.id, 'received', ['publishing', 'received']);
        this.runJob(row.id, () => this.publishUpload(row.id));
      } else if (row.state === 'staging') {
        this.runJob(row.id, () => this.stageDownload(row.id));
      }
    }
    if (sweepIntervalMs > 0) {
      this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), sweepIntervalMs);
      this.sweeper.unref();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled([...this.jobs.values()]);
  }

  /** Discards what nobody touched for too long, and the files of what is finished. */
  async sweep(): Promise<void> {
    const inactive = this.policy.inactivityTimeoutSeconds;
    const retention = this.policy.retentionSeconds;
    const [rows] = await this.pool.execute<TransferRow[]>(
      `SELECT ${COLUMNS} FROM repository_transfers
       WHERE files_present = 1 AND (
         (state IN ('receiving', 'received') AND last_activity_at < UTC_TIMESTAMP(3) - INTERVAL ? SECOND)
         OR (state = 'ready' AND last_activity_at < UTC_TIMESTAMP(3) - INTERVAL ? SECOND)
         OR state NOT IN ('receiving', 'received', 'publishing', 'staging', 'ready'))`,
      [inactive, retention],
    );
    for (const row of rows) {
      if (this.jobs.has(row.id)) continue;
      if ((ACTIVE as readonly string[]).includes(row.state)) {
        await this.pool.execute(
          `UPDATE repository_transfers SET state = 'expired', completed_at = UTC_TIMESTAMP(3)
           WHERE id = ? AND state = ?`,
          [row.id, row.state],
        );
      }
      await this.discardFiles(row.id);
    }
    const cutoff = this.now() - retention * 1000;
    for (const [key, job] of this.verifications) {
      if (job.status.state !== 'running' && job.touchedAt < cutoff) this.verifications.delete(key);
    }
    // Old rows themselves are kept for a while for diagnosis, then removed with their chunks.
    await this.pool.execute(
      `DELETE FROM repository_transfers
       WHERE files_present = 0 AND state NOT IN ('receiving', 'received', 'publishing', 'staging', 'ready')
         AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY`,
    );
  }

  private async discardFiles(id: string): Promise<void> {
    await this.staging.remove('transfers', id);
    this.staging.adopt(id, 0).release();
    await this.pool.execute(
      'UPDATE repository_transfers SET files_present = 0, reserved_bytes = 0 WHERE id = ?',
      [id],
    );
  }

  private runJob(id: string, job: () => Promise<void>): void {
    if (this.closed || this.jobs.has(id)) return;
    const running = job()
      .catch((error: unknown) => {
        this.log.error({ err: error, transferId: id }, 'A relay transfer job failed unexpectedly');
      })
      .finally(() => {
        this.jobs.delete(id);
        this.aborts.delete(id);
      });
    this.jobs.set(id, running);
  }

  private async session(repositoryId: string, signal?: AbortSignal): Promise<RepositorySession> {
    const record = await repositoryRecord(this.pool, repositoryId);
    if (!record || !record.enabled) {
      throw new ApiError(409, 'repository_disabled', 'This repository is disabled.');
    }
    return this.access.open(record.endpoint, signal);
  }

  private async withSession<T>(
    repositoryId: string,
    work: (session: RepositorySession) => Promise<T>,
  ): Promise<T> {
    let session: RepositorySession | null = null;
    try {
      session = await this.session(repositoryId);
      return await work(session);
    } catch (error) {
      throw repositoryProblem(error);
    } finally {
      session?.close();
    }
  }

  private async requireRelay(agentId: string, repositoryId: string): Promise<void> {
    if (!this.policy.relayEnabled) {
      throw new ApiError(503, 'relay_disabled', 'This server does not relay repository transfers.');
    }
    if (!this.access.configured) {
      throw new ApiError(
        503,
        'server_repository_unavailable',
        'This server has no repository connection of its own, so it cannot relay.',
      );
    }
    await this.authorization.requireRepository(agentId, repositoryId);
  }

  // Simple operations, answered at once.

  async info(agentId: string, repositoryId: string): Promise<RelayInfoResponse> {
    await this.authorization.requireRepository(agentId, repositoryId);
    const reason = !this.policy.relayEnabled
      ? 'The relay is turned off on this server (TRANSFER_RELAY_ENABLED).'
      : !this.access.configured
        ? 'This server has no repository connection of its own.'
        : null;
    return {
      enabled: reason === null,
      reason,
      chunkBytes: this.policy.chunkBytes,
      maxObjectBytes: this.policy.maxStagingBytes,
    };
  }

  async statObject(agentId: string, repositoryId: string, key: string) {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.read(agentId, repositoryId, key);
    const object = await this.withSession(repositoryId, (session) => session.stat(key));
    return { exists: object !== null, sizeBytes: object?.sizeBytes ?? null };
  }

  async freeSpace(agentId: string, repositoryId: string) {
    await this.requireRelay(agentId, repositoryId);
    return { freeBytes: await this.withSession(repositoryId, (session) => session.freeSpace()) };
  }

  async health(agentId: string, repositoryId: string): Promise<RelayHealthResponse> {
    await this.requireRelay(agentId, repositoryId);
    return this.withSession(repositoryId, async (session) => {
      await session.probe();
      return {
        hostKeyFingerprint: session.hostKeyFingerprint,
        rootReadable: true,
        rootWritable: true,
        noOverwritePublication: true,
        freeBytes: await session.freeSpace(),
      };
    });
  }

  async publish(agentId: string, repositoryId: string, stagingKey: string, finalKey: string) {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.publish(agentId, repositoryId, stagingKey, finalKey);
    await this.withSession(repositoryId, (session) => session.publish(stagingKey, finalKey));
  }

  async remove(agentId: string, repositoryId: string, key: string) {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.remove(agentId, repositoryId, key);
    await this.withSession(repositoryId, (session) => session.delete(key));
  }

  /**
   * Reads an object back in the repository and hashes it, as a job: the first request starts it, and repeating the
   * same request reports on it. A job's result is kept for the retention period.
   */
  async verify(
    agentId: string,
    repositoryId: string,
    request: RelayVerifyRequest,
  ): Promise<RelayVerifyStatus> {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.read(agentId, repositoryId, request.key);
    const id = `${repositoryId}|${request.key}|${request.sizeBytes}|${request.sha256}`;
    const existing = this.verifications.get(id);
    if (existing && existing.status.state !== 'failed') {
      existing.touchedAt = this.now();
      return existing.status;
    }
    const job: VerifyJob = {
      status: {
        state: 'running',
        doneBytes: 0,
        totalBytes: request.sizeBytes,
        sizeBytes: null,
        sha256: null,
        error: null,
      },
      touchedAt: this.now(),
    };
    this.verifications.set(id, job);
    this.runJob(`verify:${id}`, async () => {
      let session: RepositorySession | null = null;
      try {
        session = await this.session(repositoryId);
        const read = await session.verify(
          request.key,
          request.sizeBytes,
          request.sha256,
          (done) => {
            job.status = { ...job.status, doneBytes: done };
          },
        );
        job.status = {
          ...job.status,
          state: 'verified',
          sizeBytes: read.sizeBytes,
          sha256: read.sha256,
        };
      } catch (error) {
        const problem =
          error instanceof RepositoryAccessError || error instanceof ApiError
            ? { code: error.code, message: error.message.slice(0, 1024) }
            : { code: 'repository_error', message: 'The object could not be read back.' };
        job.status = { ...job.status, state: 'failed', error: problem };
      } finally {
        session?.close();
        job.touchedAt = this.now();
      }
    });
    return job.status;
  }

  // Transfers.

  private async row(id: string): Promise<TransferRow | null> {
    if (!UUID.test(id)) return null;
    const [rows] = await this.pool.execute<TransferRow[]>(
      `SELECT ${COLUMNS} FROM repository_transfers WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async setState(
    id: string,
    state: TransferState,
    from: readonly TransferState[],
  ): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE repository_transfers SET state = ?, error_code = NULL, error_message = NULL
       WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`,
      [state, id, ...from],
    );
    return result.affectedRows > 0;
  }

  private async failTransfer(id: string, code: string, message: string): Promise<void> {
    await this.pool.execute(
      `UPDATE repository_transfers
       SET state = 'failed', error_code = ?, error_message = ?, completed_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND state IN ('receiving', 'received', 'publishing', 'staging', 'ready')`,
      [code, message.slice(0, 1024), id],
    );
    await this.discardFiles(id);
  }

  private async status(row: TransferRow): Promise<TransferStatus> {
    const size = row.size_bytes === null ? null : Number(row.size_bytes);
    const chunkCount = size === null ? null : chunkCountOf(size, row.chunk_bytes);
    let missing: Array<[number, number]> = [];
    let done = Number(row.done_bytes);
    if (row.direction === 'upload' && chunkCount !== null && row.state === 'receiving') {
      const [chunks] = await this.pool.execute<RowDataPacket[]>(
        'SELECT chunk_index FROM repository_transfer_chunks WHERE transfer_id = ? ORDER BY chunk_index',
        [row.id],
      );
      const present = chunks.map((chunk) => Number(chunk.chunk_index));
      missing = missingRanges(present, chunkCount);
      done = Math.min(size ?? 0, present.length * row.chunk_bytes);
    }
    const active = (ACTIVE as readonly string[]).includes(row.state);
    const timeout =
      row.state === 'ready' ? this.policy.retentionSeconds : this.policy.inactivityTimeoutSeconds;
    return {
      transferId: row.id,
      direction: row.direction,
      state: row.state,
      key: row.object_key,
      sizeBytes: size,
      sha256: row.sha256,
      chunkBytes: row.chunk_bytes,
      chunkCount,
      missingChunks: missing,
      doneBytes: done,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
      updatedAt: row.updated_at.toISOString(),
      expiresAt: active
        ? new Date(row.last_activity_at.getTime() + timeout * 1000).toISOString()
        : null,
    };
  }

  private async touch(id: string): Promise<void> {
    await this.pool.execute(
      'UPDATE repository_transfers SET last_activity_at = UTC_TIMESTAMP(3) WHERE id = ?',
      [id],
    );
  }

  /** An upload's row, which only the agent that started it can see. */
  private async ownUpload(agentId: string, repositoryId: string, id: string): Promise<TransferRow> {
    const row = await this.row(id);
    if (
      !row ||
      row.direction !== 'upload' ||
      row.agent_id !== agentId ||
      row.repository_id !== repositoryId
    ) {
      throw notFound();
    }
    return row;
  }

  private async activeCount(): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM repository_transfers
       WHERE state IN ('receiving', 'received', 'publishing', 'staging')`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async requireCapacity(): Promise<void> {
    if ((await this.activeCount()) >= this.policy.maxConcurrent) {
      throw new ApiError(
        503,
        'transfer_busy',
        'The server is relaying as many transfers as it allows. Try again shortly.',
      );
    }
  }

  /**
   * Starts or resumes an upload. The same key, size and hash from the same agent resume the transfer already
   * receiving; anything else at that key replaces an unfinished upload of it.
   */
  async startUpload(
    agentId: string,
    repositoryId: string,
    request: UploadInitRequest,
  ): Promise<TransferStatus> {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.write(agentId, repositoryId, request.key);
    if (request.sizeBytes > this.policy.maxStagingBytes) {
      throw new ApiError(
        413,
        'transfer_too_large',
        'This object is larger than the server’s transfer staging.',
      );
    }
    const [existing] = await this.pool.execute<TransferRow[]>(
      `SELECT ${COLUMNS} FROM repository_transfers
       WHERE direction = 'upload' AND repository_id = ? AND object_key = ? AND active_marker = 1`,
      [repositoryId, request.key],
    );
    const current = existing[0];
    if (current) {
      if (
        current.agent_id === agentId &&
        Number(current.size_bytes) === request.sizeBytes &&
        current.sha256 === request.sha256
      ) {
        await this.touch(current.id);
        return this.status((await this.row(current.id)) as TransferRow);
      }
      await this.cancelTransfer(current.id, 'Replaced by a new upload to the same key.');
    }

    await this.requireCapacity();
    const id = randomUUID();
    try {
      await this.staging.reserve(id, request.sizeBytes);
    } catch (error) {
      throw repositoryProblem(error);
    }
    try {
      const directory = await this.staging.create('transfers', id);
      const file = await open(join(directory, DATA_FILE), 'wx', 0o600);
      try {
        await file.truncate(request.sizeBytes);
      } finally {
        await file.close();
      }
      await this.pool.execute(
        `INSERT INTO repository_transfers
           (id, direction, state, repository_id, object_key, agent_id, size_bytes, sha256, chunk_bytes,
            reserved_bytes)
         VALUES (?, 'upload', 'receiving', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repositoryId,
          request.key,
          agentId,
          request.sizeBytes,
          request.sha256,
          this.policy.chunkBytes,
          request.sizeBytes,
        ],
      );
    } catch (error) {
      await this.staging.remove('transfers', id).catch(() => undefined);
      this.staging.adopt(id, 0).release();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ApiError(
          409,
          'transfer_conflict',
          'Another upload to this key started at the same time.',
        );
      }
      throw error;
    }
    this.log.info(
      { transferId: id, repositoryId, agentId, sizeBytes: request.sizeBytes },
      'Relay upload started',
    );
    return this.status((await this.row(id)) as TransferRow);
  }

  async uploadStatus(agentId: string, repositoryId: string, id: string): Promise<TransferStatus> {
    await this.authorization.requireRepository(agentId, repositoryId);
    return this.status(await this.ownUpload(agentId, repositoryId, id));
  }

  /**
   * One chunk: exactly the chunk size (the last one, the remainder), and exactly the bytes its hash names. A chunk
   * that is already there with the same hash is acknowledged again; with another hash, refused.
   */
  async putChunk(
    agentId: string,
    repositoryId: string,
    id: string,
    index: number,
    declaredSha256: string | undefined,
    contentLength: number | undefined,
    body: Readable,
  ): Promise<ChunkAck> {
    await this.requireRelay(agentId, repositoryId);
    const row = await this.ownUpload(agentId, repositoryId, id);
    if (row.state !== 'receiving') {
      throw new ApiError(
        409,
        'transfer_not_receiving',
        'This upload is no longer receiving chunks.',
      );
    }
    if (!declaredSha256 || !SHA256.test(declaredSha256)) {
      throw new ApiError(
        400,
        'chunk_hash_required',
        'Each chunk needs its SHA-256 in x-emucat-chunk-sha256.',
      );
    }
    const size = Number(row.size_bytes);
    const count = chunkCountOf(size, row.chunk_bytes);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
      throw new ApiError(400, 'chunk_out_of_range', 'There is no chunk with that index.');
    }
    const expected = index === count - 1 ? size - index * row.chunk_bytes : row.chunk_bytes;
    if (contentLength !== undefined && contentLength !== expected) {
      body.resume();
      throw new ApiError(
        400,
        'chunk_size_mismatch',
        `This chunk must be exactly ${expected} bytes.`,
      );
    }
    const data = await readBounded(body, expected);
    if (data.length !== expected) {
      throw new ApiError(
        400,
        'chunk_size_mismatch',
        `This chunk must be exactly ${expected} bytes.`,
      );
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== declaredSha256) {
      throw new ApiError(
        422,
        'chunk_hash_mismatch',
        'The chunk does not match its SHA-256. Send it again.',
      );
    }
    const [stored] = await this.pool.execute<RowDataPacket[]>(
      'SELECT sha256 FROM repository_transfer_chunks WHERE transfer_id = ? AND chunk_index = ?',
      [id, index],
    );
    if (stored[0] && stored[0].sha256 !== actual) {
      throw new ApiError(
        409,
        'chunk_conflict',
        'A different chunk with this index was already received.',
      );
    }
    if (!stored[0]) {
      const file = await open(join(this.staging.directory('transfers', id), DATA_FILE), 'r+');
      try {
        let written = 0;
        while (written < data.length) {
          const { bytesWritten } = await file.write(
            data,
            written,
            data.length - written,
            index * row.chunk_bytes + written,
          );
          written += bytesWritten;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      await this.pool.execute(
        `INSERT IGNORE INTO repository_transfer_chunks (transfer_id, chunk_index, sha256) VALUES (?, ?, ?)`,
        [id, index, actual],
      );
    }
    const [counted] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM repository_transfer_chunks WHERE transfer_id = ?',
      [id],
    );
    const received = Number(counted[0]?.count ?? 0);
    await this.pool.execute(
      `UPDATE repository_transfers SET done_bytes = LEAST(size_bytes, ? * chunk_bytes),
         last_activity_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [received, id],
    );
    return { transferId: id, index, receivedChunks: received, chunkCount: count };
  }

  /**
   * Every chunk is there: the whole file is checked against the declared SHA-256, then written to the repository's
   * staging key. Idempotent: a completed or completing upload reports its state.
   */
  async completeUpload(agentId: string, repositoryId: string, id: string): Promise<TransferStatus> {
    await this.requireRelay(agentId, repositoryId);
    const row = await this.ownUpload(agentId, repositoryId, id);
    if (row.state === 'receiving') {
      const status = await this.status(row);
      if (status.missingChunks.length > 0) {
        throw new ApiError(
          409,
          'transfer_incomplete',
          'Chunks are missing; the status lists them.',
        );
      }
      await this.setState(id, 'received', ['receiving']);
    }
    if (row.state === 'receiving' || row.state === 'received') {
      this.runJob(id, () => this.publishUpload(id));
    }
    return this.status((await this.row(id)) as TransferRow);
  }

  private async publishUpload(id: string): Promise<void> {
    const row = await this.row(id);
    if (!row || row.state !== 'received') return;
    const path = join(this.staging.directory('transfers', id), DATA_FILE);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    let session: RepositorySession | null = null;
    try {
      const whole = await hashFile(path, abort.signal);
      if (whole.sizeBytes !== Number(row.size_bytes) || whole.sha256 !== row.sha256) {
        await this.failTransfer(
          id,
          'hash_mismatch',
          'The assembled upload does not match its declared SHA-256.',
        );
        return;
      }
      if (!(await this.setState(id, 'publishing', ['received']))) return;
      session = await this.session(row.repository_id, abort.signal);
      await session.upload(
        path,
        row.object_key,
        (done) => {
          void this.pool
            .execute('UPDATE repository_transfers SET done_bytes = ? WHERE id = ?', [done, id])
            .catch(() => undefined);
        },
        abort.signal,
      );
      await this.pool.execute(
        `UPDATE repository_transfers SET state = 'published', done_bytes = size_bytes,
           completed_at = UTC_TIMESTAMP(3) WHERE id = ? AND state = 'publishing'`,
        [id],
      );
      // The repository has it now: the server's copy is no longer needed.
      await this.discardFiles(id);
      this.log.info({ transferId: id }, 'Relay upload written to the repository');
    } catch (error) {
      if (abort.signal.aborted && this.closed) return;
      const problem =
        error instanceof RepositoryAccessError || error instanceof ApiError
          ? { code: error.code, message: error.message }
          : {
              code: 'repository_error',
              message: 'The upload could not be written to the repository.',
            };
      this.log.warn({ transferId: id, code: problem.code }, 'Relay upload failed');
      await this.failTransfer(id, problem.code, problem.message);
    } finally {
      session?.close();
    }
  }

  async cancelUpload(agentId: string, repositoryId: string, id: string): Promise<TransferStatus> {
    await this.authorization.requireRepository(agentId, repositoryId);
    await this.ownUpload(agentId, repositoryId, id);
    await this.cancelTransfer(id, 'Cancelled by the agent.');
    return this.status((await this.row(id)) as TransferRow);
  }

  private async cancelTransfer(id: string, message: string): Promise<void> {
    this.aborts.get(id)?.abort();
    await this.pool.execute(
      `UPDATE repository_transfers
       SET state = 'cancelled', error_code = 'cancelled', error_message = ?, completed_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND state IN ('receiving', 'received', 'publishing', 'staging', 'ready')`,
      [message, id],
    );
    await this.jobs.get(id);
    await this.discardFiles(id);
  }

  /** Stages one object for download, or joins the copy already staged or staging. */
  async startDownload(agentId: string, repositoryId: string, key: string): Promise<TransferStatus> {
    await this.requireRelay(agentId, repositoryId);
    await this.authorization.read(agentId, repositoryId, key);
    const [existing] = await this.pool.execute<TransferRow[]>(
      `SELECT ${COLUMNS} FROM repository_transfers
       WHERE direction = 'download' AND repository_id = ? AND object_key = ? AND active_marker = 1`,
      [repositoryId, key],
    );
    if (existing[0]) {
      await this.touch(existing[0].id);
      return this.status((await this.row(existing[0].id)) as TransferRow);
    }
    await this.requireCapacity();
    const object = await this.withSession(repositoryId, (session) => session.stat(key));
    if (!object)
      throw new ApiError(404, 'remote_object_missing', 'The object is not in the repository.');
    const id = randomUUID();
    try {
      await this.staging.reserve(id, object.sizeBytes);
    } catch (error) {
      throw repositoryProblem(error);
    }
    try {
      await this.staging.create('transfers', id);
      await this.pool.execute(
        `INSERT INTO repository_transfers
           (id, direction, state, repository_id, object_key, agent_id, size_bytes, chunk_bytes, reserved_bytes)
         VALUES (?, 'download', 'staging', ?, ?, NULL, ?, ?, ?)`,
        [id, repositoryId, key, object.sizeBytes, this.policy.chunkBytes, object.sizeBytes],
      );
    } catch (error) {
      await this.staging.remove('transfers', id).catch(() => undefined);
      this.staging.adopt(id, 0).release();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        return this.startDownload(agentId, repositoryId, key);
      }
      throw error;
    }
    this.runJob(id, () => this.stageDownload(id));
    this.log.info(
      { transferId: id, repositoryId, sizeBytes: object.sizeBytes },
      'Relay download staging',
    );
    return this.status((await this.row(id)) as TransferRow);
  }

  private async stageDownload(id: string): Promise<void> {
    const row = await this.row(id);
    if (!row || row.state !== 'staging') return;
    // A restart may have left part of an earlier attempt: start from nothing.
    await this.staging.remove('transfers', id);
    const path = join(await this.staging.create('transfers', id), DATA_FILE);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    let session: RepositorySession | null = null;
    try {
      // Checked against what EmuCat registered for this object, whichever agent asks.
      const [registered] = await this.pool.execute<RowDataPacket[]>(
        `SELECT archive_size_bytes, archive_sha256 FROM vm_versions WHERE repository_id = ? AND archive_key = ?`,
        [row.repository_id, row.object_key],
      );
      session = await this.session(row.repository_id, abort.signal);
      const received = await session.download(
        row.object_key,
        path,
        (done) => {
          void this.pool
            .execute(
              'UPDATE repository_transfers SET done_bytes = ?, last_activity_at = UTC_TIMESTAMP(3) WHERE id = ?',
              [done, id],
            )
            .catch(() => undefined);
        },
        abort.signal,
      );
      const expected = registered[0];
      if (
        expected &&
        (Number(expected.archive_size_bytes) !== received.sizeBytes ||
          expected.archive_sha256 !== received.sha256)
      ) {
        await this.failTransfer(
          id,
          'hash_mismatch',
          'The stored object is not the one that was registered.',
        );
        return;
      }
      await this.pool.execute(
        `UPDATE repository_transfers
         SET state = 'ready', size_bytes = ?, sha256 = ?, done_bytes = ?, last_activity_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND state = 'staging'`,
        [received.sizeBytes, received.sha256, received.sizeBytes, id],
      );
    } catch (error) {
      if (abort.signal.aborted && this.closed) return;
      const problem =
        error instanceof RepositoryAccessError || error instanceof ApiError
          ? { code: error.code, message: error.message }
          : { code: 'repository_error', message: 'The object could not be staged.' };
      this.log.warn({ transferId: id, code: problem.code }, 'Relay download failed');
      await this.failTransfer(id, problem.code, problem.message);
    } finally {
      session?.close();
    }
  }

  /** A download's row, for an agent that may read its object. */
  private async readableDownload(
    agentId: string,
    repositoryId: string,
    id: string,
  ): Promise<TransferRow> {
    await this.authorization.requireRepository(agentId, repositoryId);
    const row = await this.row(id);
    if (!row || row.direction !== 'download' || row.repository_id !== repositoryId)
      throw notFound();
    await this.authorization.read(agentId, repositoryId, row.object_key);
    return row;
  }

  async downloadStatus(agentId: string, repositoryId: string, id: string): Promise<TransferStatus> {
    const row = await this.readableDownload(agentId, repositoryId, id);
    if (row.state === 'ready') await this.touch(id);
    return this.status(row);
  }

  /**
   * The staged bytes, whole or one range. Only a verified copy is ever served, and its SHA-256 goes with it so the
   * agent checks what it assembled.
   */
  async openContent(
    agentId: string,
    repositoryId: string,
    id: string,
    range: string | undefined,
  ): Promise<{
    stream: Readable;
    start: number;
    end: number;
    sizeBytes: number;
    sha256: string;
    partial: boolean;
  }> {
    const row = await this.readableDownload(agentId, repositoryId, id);
    if (row.state !== 'ready' || row.sha256 === null || row.size_bytes === null) {
      throw new ApiError(
        409,
        'transfer_not_ready',
        'The object is not staged yet; the status says when it is.',
      );
    }
    const size = Number(row.size_bytes);
    const path = join(this.staging.directory('transfers', id), DATA_FILE);
    const present = await stat(path).catch(() => null);
    if (!present || present.size !== size) {
      await this.failTransfer(
        id,
        'staging_failed',
        'The staged copy is gone. Start the download again.',
      );
      throw new ApiError(
        410,
        'transfer_expired',
        'The staged copy is gone. Start the download again.',
      );
    }
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (range !== undefined) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range.trim());
      if (!match)
        throw new ApiError(416, 'range_not_satisfiable', 'Only one byte range is supported.');
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || start >= size || end < start) {
        throw new ApiError(416, 'range_not_satisfiable', `The object is ${size} bytes.`);
      }
      partial = true;
    }
    await this.touch(id);
    const stream = size === 0 ? Readable.from([]) : createReadStream(path, { start, end });
    return { stream, start, end, sizeBytes: size, sha256: row.sha256, partial };
  }
}

async function readBounded(body: Readable, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      body.destroy();
      throw new ApiError(413, 'chunk_too_large', `This chunk must be at most ${limit} bytes.`);
    }
    parts.push(buffer);
  }
  return Buffer.concat(parts, total);
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
