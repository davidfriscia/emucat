import { randomUUID } from 'node:crypto';
import {
  archiveObjectKey,
  isRegistrationCommitted,
  isRegistrationTerminal,
  OVA_IMPORT_MAX_BYTES,
  type CompleteOvaImportRequest,
  type CompleteOvaImportResponse,
  type CreateOvaImportRequest,
  type FailOvaImportRequest,
  type OvaImportPreflightRequest,
  type OvaImportPreflightResponse,
  type OvaImportProgressRequest,
  type RegistrationOperation,
  type RegistrationState,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import type { RegistrationCoordinator } from './coordinator.js';

/** The states from which each stage is believed. Back and forth, since a failed verification uploads again. */
const STAGE_ALLOWED_FROM: Record<OvaImportProgressRequest['stage'], readonly RegistrationState[]> =
  {
    uploading: ['queued', 'uploading', 'verifying'],
    verifying: ['uploading', 'verifying'],
  };

const isDuplicateEntry = (error: unknown): boolean =>
  (error as { code?: string }).code === 'ER_DUP_ENTRY';

const notFound = () => new ApiError(404, 'import_not_found', 'Import not found');

interface Eligibility {
  repositoryId: string;
  repositoryName: string;
}

/**
 * Importing an existing OVA from the agent's command line (decision 0049). The agent authenticates with its own
 * credential; nothing here trusts anything else it says about itself. An import is a registration operation with
 * `mode = 'import'`, so it has the registration's identities issued up front, its active markers (one operation per
 * VM and per agent, whatever happens), its states, and its commit, which `RegistrationCoordinator` performs.
 *
 * What an agent may do here is narrow: create a new VirtualBox catalog VM whose name is free, in a repository an
 * administrator associated it with, and only through an operation it created itself. It can never change, replace
 * or delete an existing VM or version. Every handler is idempotent, since the command line repeats a request whose
 * answer it did not get.
 */
export class OvaImportCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly registrations: RegistrationCoordinator,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Whether an import of this name could start now. Reserves and changes nothing. */
  async preflight(
    agentId: string,
    input: OvaImportPreflightRequest,
  ): Promise<OvaImportPreflightResponse> {
    const connection = await this.pool.getConnection();
    try {
      const eligibility = await this.eligibility(connection, agentId, input.vmName, false);
      if (input.archiveSizeBytes !== undefined) tooLarge(input.archiveSizeBytes);
      const [active] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM registration_operations
         WHERE emulator_type = 'virtualbox' AND vm_name = ? AND active_marker = 1`,
        [input.vmName],
      );
      if (active[0]) throw inProgress();
      return {
        emulatorType: 'virtualbox',
        vmName: input.vmName,
        ...eligibility,
        maxArchiveBytes: OVA_IMPORT_MAX_BYTES,
      };
    } finally {
      connection.release();
    }
  }

  /**
   * Reserves the name and issues the version and its archive key. A repeated request, with the same request ID,
   * finds the operation it already created, in whatever state it is now; the same ID with anything else is refused.
   */
  async create(agentId: string, input: CreateOvaImportRequest): Promise<RegistrationOperation> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(agentId, repeated, input);
    tooLarge(input.archiveSizeBytes);

    const operationId = randomUUID();
    const versionId = randomUUID();
    const archiveKey = archiveObjectKey(
      { emulatorType: 'virtualbox', vmName: input.vmName },
      versionId,
    );
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const { repositoryId } = await this.eligibility(connection, agentId, input.vmName, true);
      try {
        await connection.execute(
          `INSERT INTO registration_operations
             (id, agent_id, repository_id, requested_by_user_id, emulator_type, vm_name, virtualbox_uuid,
              mode, version_id, archive_key, request_id, import_description, import_source_name,
              import_size_bytes, import_sha256)
           VALUES (?, ?, ?, NULL, 'virtualbox', ?, NULL, 'import', ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            repositoryId,
            input.vmName,
            versionId,
            archiveKey,
            input.requestId,
            input.description ?? null,
            input.sourceFileName,
            input.archiveSizeBytes,
            input.archiveSha256,
          ],
        );
      } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        await connection.rollback();
        // The same request, sent twice at once, created it in the meantime.
        const raced = await this.byRequest(input.requestId);
        if (raced) return this.sameRequest(agentId, raced, input);
        throw inProgress();
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    this.log.info(
      { agentId, operationId, vmName: input.vmName, sizeBytes: input.archiveSizeBytes },
      'OVA import created',
    );
    return this.require(agentId, operationId);
  }

  async get(agentId: string, operationId: string): Promise<RegistrationOperation> {
    return this.require(agentId, operationId);
  }

  /**
   * What the agent is doing. Answered with the operation as it is now, so that the agent learns of a cancellation
   * at its next report. A stage that cannot follow the current one is refused; an operation that has ended is
   * returned as it is, unchanged.
   */
  async progress(
    agentId: string,
    operationId: string,
    input: OvaImportProgressRequest,
  ): Promise<RegistrationOperation> {
    const before = await this.require(agentId, operationId);
    if (isRegistrationTerminal(before.state) || isRegistrationCommitted(before.state))
      return before;
    const allowed = STAGE_ALLOWED_FROM[input.stage];
    const placeholders = allowed.map(() => '?').join(', ');
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE registration_operations
       SET state = ?, progress_done_bytes = ?, progress_total_bytes = ?
       WHERE id = ? AND agent_id = ? AND mode = 'import' AND state IN (${placeholders})`,
      [input.stage, input.doneBytes, input.totalBytes, operationId, agentId, ...allowed],
    );
    const after = await this.require(agentId, operationId);
    if (result.affectedRows === 0 && !isRegistrationTerminal(after.state)) {
      throw new ApiError(
        409,
        'invalid_import_state',
        `An import that is ${after.state} cannot move to ${input.stage}.`,
      );
    }
    return after;
  }

  /**
   * The agent gave up, or was asked to stop, before the master existed: nothing was registered. Once the master is
   * committed it is too late, and the answer is the committed operation, so that the agent says so.
   */
  async fail(
    agentId: string,
    operationId: string,
    input: FailOvaImportRequest,
  ): Promise<RegistrationOperation> {
    await this.require(agentId, operationId);
    const cancelled = input.code === 'cancelled';
    await this.pool.execute(
      `UPDATE registration_operations
       SET state = ?, error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3),
           cancel_requested_at = IF(?, COALESCE(cancel_requested_at, UTC_TIMESTAMP(3)), cancel_requested_at)
       WHERE id = ? AND agent_id = ? AND mode = 'import'
         AND state IN ('queued', 'validating', 'archiving', 'uploading', 'verifying')`,
      [
        cancelled ? 'cancelled' : 'failed',
        input.code,
        cancelled ? 'Cancelled on the agent’s command line.' : input.message || input.code,
        cancelled,
        operationId,
        agentId,
      ],
    );
    return this.require(agentId, operationId);
  }

  /** The published and verified archive. Committed in one transaction, or rejected with nothing registered. */
  async complete(
    agentId: string,
    operationId: string,
    input: CompleteOvaImportRequest,
  ): Promise<CompleteOvaImportResponse> {
    await this.require(agentId, operationId);
    const ack = await this.registrations.completeImport(agentId, { operationId, ...input });
    const operation = await this.require(agentId, operationId);
    if (ack.outcome === 'committed') {
      this.log.info(
        { agentId, operationId, versionId: operation.versionId },
        'OVA import committed',
      );
      return { outcome: 'committed', deletePublished: false, operation };
    }
    return {
      outcome: 'rejected',
      deletePublished: ack.outcome === 'rejected' && ack.deletePublished === true,
      operation,
    };
  }

  // Checks.

  /**
   * Who may import what, checked again by the commit: an agent that is not revoked, busy with nothing else that
   * reads or writes its disks, associated with an enabled repository, and a catalog name that no VM has.
   */
  private async eligibility(
    connection: PoolConnection,
    agentId: string,
    vmName: string,
    lock: boolean,
  ): Promise<Eligibility> {
    const [agents] = await connection.execute<RowDataPacket[]>(
      `SELECT revoked_at FROM agents WHERE id = ?${lock ? ' LOCK IN SHARE MODE' : ''}`,
      [agentId],
    );
    if (!agents[0] || agents[0].revoked_at) {
      throw new ApiError(401, 'unauthorized', 'Authentication required');
    }
    const [busy] = await connection.execute<RowDataPacket[]>(
      `SELECT 'registration' AS kind FROM registration_operations WHERE agent_id = ? AND active_marker = 1
       UNION ALL
       SELECT 'restore' FROM restore_operations WHERE agent_id = ? AND active_marker = 1
       UNION ALL
       SELECT 'verification' FROM vm_verifications WHERE agent_id = ? AND active_marker = 1
       UNION ALL
       SELECT 'local copy removal' FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1`,
      [agentId, agentId, agentId, agentId],
    );
    if (busy[0]) {
      throw new ApiError(
        409,
        'agent_busy',
        `A ${busy[0].kind as string} is running on this agent. Wait for it to finish, or cancel it in the web app.`,
      );
    }
    const [repositories] = await connection.execute<RowDataPacket[]>(
      `SELECT r.id, r.name FROM repositories AS r
       JOIN agent_repositories AS ar ON ar.repository_id = r.id AND ar.agent_id = ?
       WHERE r.enabled
       ORDER BY r.created_at, r.id`,
      [agentId],
    );
    const repository = repositories[0];
    if (!repository) {
      throw new ApiError(
        409,
        'repository_not_authorized',
        'This agent is not associated with an enabled repository. Associate it on the Repositories page.',
      );
    }
    const [existing] = await connection.execute<RowDataPacket[]>(
      `SELECT vm_name FROM virtual_machines WHERE emulator_type = 'virtualbox' AND vm_name = ?${
        lock ? ' LOCK IN SHARE MODE' : ''
      }`,
      [vmName],
    );
    if (existing[0]) {
      throw new ApiError(
        409,
        'vm_already_registered',
        `A VirtualBox VM named ${existing[0].vm_name as string} is already in the catalog. Its master is never replaced by an import: choose another name.`,
      );
    }
    return { repositoryId: repository.id as string, repositoryName: repository.name as string };
  }

  private async byRequest(requestId: string): Promise<RowDataPacket | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, agent_id, mode, vm_name, import_size_bytes, import_sha256
       FROM registration_operations WHERE request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private async sameRequest(
    agentId: string,
    row: RowDataPacket,
    input: CreateOvaImportRequest,
  ): Promise<RegistrationOperation> {
    if (
      row.agent_id !== agentId ||
      row.mode !== 'import' ||
      (row.vm_name as string).toLowerCase() !== input.vmName.toLowerCase() ||
      Number(row.import_size_bytes) !== input.archiveSizeBytes ||
      row.import_sha256 !== input.archiveSha256
    ) {
      throw new ApiError(
        409,
        'request_conflict',
        'This request ID was already used for another request.',
      );
    }
    return this.require(agentId, row.id as string);
  }

  /** The operation, only if it is this agent's import. Anyone else's is not found, whoever asks. */
  private async require(agentId: string, operationId: string): Promise<RegistrationOperation> {
    const operation = await this.registrations.get(operationId);
    if (!operation || operation.agentId !== agentId || operation.mode !== 'import')
      throw notFound();
    return operation;
  }
}

function tooLarge(sizeBytes: number): void {
  if (sizeBytes > OVA_IMPORT_MAX_BYTES) {
    throw new ApiError(
      413,
      'archive_too_large',
      `The OVA is larger than this server accepts (${OVA_IMPORT_MAX_BYTES} bytes).`,
    );
  }
}

const inProgress = () =>
  new ApiError(
    409,
    'registration_in_progress',
    'An import or registration of this VM, or another operation on this agent, is already running.',
  );
