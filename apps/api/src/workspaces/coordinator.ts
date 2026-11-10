import { createHash, randomUUID } from 'node:crypto';
import {
  isRegistrationCommitted,
  isRegistrationTerminal,
  isSessionActive,
  remoteSessionRecovery,
  vmNameKey,
  type CreateWorkspaceRequest,
  type RegistrationOperation,
  type RemoteSession,
  type RemoteSessionMode,
  type ServerMessage,
  type VmIdentity,
  type VmSession,
  type VmWorkspace,
  type WorkspaceDiscardResultPayload,
  type WorkspacePurpose,
  type WorkspaceState,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import type { ExecutionCoordinator } from '../execution/coordinator.js';
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import type { RestoreCoordinator } from '../restore/coordinator.js';

export interface WorkspaceLink {
  isOnline(agentId: string): boolean;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

export interface RemoteSessionOptions {
  /** How often the server looks for remote sessions whose next step is due. 0 disables the timer. */
  sweepIntervalMs: number;
  /** Automatic publication attempts, the first included. An administrator can always retry. */
  maxAutomaticAttempts: number;
  /** The wait before each automatic retry of a publication, by attempt. The last one repeats. */
  publishRetryDelaysMs: readonly number[];
  /** How long a cleanup request may go unanswered before it is sent again. */
  discardRetryMs: number;
}

const DEFAULT_OPTIONS: RemoteSessionOptions = {
  sweepIntervalMs: 15_000,
  maxAutomaticAttempts: 3,
  publishRetryDelaysMs: [30_000, 120_000],
  discardRetryMs: 60_000,
};

/**
 * Publication errors that another attempt cannot cure: the snapshot's lineage, the repository's
 * authorization, or a working copy that is gone. They wait for an administrator.
 */
const PERMANENT_PUBLICATION_ERRORS = new Set([
  'snapshot_parent_mismatch',
  'snapshot_parent_unknown',
  'snapshot_lineage_unverified',
  'repository_disabled',
  'repository_not_authorized',
  'repository_not_configured',
  'workspace_unavailable',
  'workspace_purpose_mismatch',
  'workspace_not_found',
  'version_not_found',
  'agent_cannot_snapshot',
  'agent_revoked',
  'archive_exists',
  'duplicate_registration',
  'invalid_request',
  'host_key_unknown',
  'host_key_changed',
  'ssh_authentication_failed',
  'publication_unsupported',
]);

interface WorkspaceRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  requested_by_user_id: string | null;
  requested_by_display_name: string | null;
  request_id: string | null;
  emulator_type: VmWorkspace['emulatorType'];
  vm_name: string;
  purpose: WorkspacePurpose;
  state: WorkspaceState;
  base_version_id: string;
  source_version_id: string;
  session_id: string | null;
  snapshot_operation_id: string | null;
  snapshot_version_id: string | null;
  publish_attempts: number | string;
  next_retry_at: Date | null;
  due: number | string | null;
  abandoned_at: Date | null;
  may_have_changes: number;
  launch_on_ready: number;
  restore_operation_id: string | null;
  local_directory: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const WORKSPACE_QUERY = `
  SELECT w.id, w.agent_id, a.name AS agent_name, w.requested_by_user_id,
         u.display_name AS requested_by_display_name, w.request_id, w.emulator_type, w.vm_name,
         w.purpose, w.state, w.base_version_id, w.source_version_id, w.session_id,
         w.snapshot_operation_id, w.publish_attempts, w.next_retry_at,
         (w.next_retry_at IS NOT NULL AND w.next_retry_at <= UTC_TIMESTAMP(3)) AS due,
         w.abandoned_at, w.may_have_changes, w.launch_on_ready, w.local_directory, w.error_code,
         w.error_message, w.created_at, w.updated_at, w.finished_at,
         (SELECT op.id FROM restore_operations AS op WHERE op.workspace_id = w.id
           ORDER BY op.created_at DESC LIMIT 1) AS restore_operation_id,
         (SELECT reg.version_id FROM registration_operations AS reg
           WHERE reg.id = w.snapshot_operation_id
             AND reg.state IN ('cleaning_local', 'succeeded', 'partial_success')) AS snapshot_version_id
  FROM vm_workspaces AS w
  JOIN agents AS a ON a.id = w.agent_id
  LEFT JOIN users AS u ON u.id = w.requested_by_user_id`;

function toWorkspace(row: WorkspaceRow, online: boolean): VmWorkspace {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentOnline: online,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    purpose: row.purpose,
    state: row.state,
    baseVersionId: row.base_version_id,
    sourceVersionId: row.source_version_id,
    mayHaveChanges: row.may_have_changes !== 0,
    launchOnReady: row.launch_on_ready !== 0,
    restoreOperationId: row.restore_operation_id,
    sessionId: row.session_id,
    snapshotOperationId: row.snapshot_operation_id,
    publishAttempts: Number(row.publish_attempts),
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    abandonedAt: row.abandoned_at?.toISOString() ?? null,
    snapshotVersionId: row.snapshot_version_id,
    localDirectory: row.local_directory,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    requestedByDisplayName: row.requested_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/**
 * The request ID of a Remote Snapshot's publication attempt. It is derived from the working copy and the
 * attempt's number, so that asking again after a crash finds the operation already created rather than
 * creating a second one; the attempt's number only moves once that operation is recorded.
 */
export function publicationRequestId(workspaceId: string, attempt: number): string {
  const hex = createHash('sha256')
    .update(`emucat/remote-snapshot/${workspaceId}/${attempt}`)
    .digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** How a remote session's emulator ended, as far as what may follow is concerned. */
type RunOutcome = 'active' | 'never_started' | 'unaccounted' | 'ended';

function runOutcome(session: VmSession | null): RunOutcome {
  if (!session) return 'unaccounted';
  if (isSessionActive(session.state)) return 'active';
  if (session.processStartedAt === null && session.pid === null && session.state === 'failed') {
    return 'never_started';
  }
  if (session.state === 'interrupted') return 'unaccounted';
  return 'ended';
}

const isAutomatic = (purpose: WorkspacePurpose): purpose is RemoteSessionMode =>
  purpose !== 'manual';

/**
 * Working copies on the server's side: remote sessions (decision 0040), and the Milestone 7 working copies
 * prepared by hand (decision 0038), which keep their old lifecycle and are never advanced automatically.
 *
 * A remote session is driven from the database, one guarded step at a time: the restore that prepares it,
 * the session that runs it, the snapshot registration that publishes it (Remote Snapshot), and the
 * discard that cleans it up. Every step is conditional on the state it starts from, so a repeated report,
 * a missed notification or a restart of either side moves it on exactly once. Nothing is ever removed
 * while its emulator may run, and an unpublished Remote Snapshot is only removed if an administrator
 * abandons it.
 */
export class WorkspaceCoordinator {
  private readonly options: RemoteSessionOptions;
  private readonly queue = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly link: WorkspaceLink,
    private readonly log: FastifyBaseLogger,
    private readonly restores: RestoreCoordinator,
    private readonly execution: ExecutionCoordinator,
    private readonly registrations: RegistrationCoordinator,
    options: Partial<RemoteSessionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    restores.onWorkspaceReady = (workspaceId) => {
      this.kick(workspaceId);
      void this.launchIfAsked(workspaceId).catch((error: unknown) => {
        this.log.error({ workspaceId, err: error }, 'Cannot launch a ready working copy');
      });
    };
    execution.onWorkspaceSession = (workspaceId, confirmed) => this.kick(workspaceId, confirmed);
    registrations.onWorkspaceSnapshot = (workspaceId) => this.kick(workspaceId);
  }

  /** Starts the periodic sweep, which retries what is due and catches anything a notification missed. */
  start(): void {
    if (this.timer || this.options.sweepIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.log.error({ err: error }, 'The remote session sweep failed');
      });
    }, this.options.sweepIntervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.queue.values()]);
  }

  private async row(workspaceId: string): Promise<WorkspaceRow | null> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(`${WORKSPACE_QUERY} WHERE w.id = ?`, [
      workspaceId,
    ]);
    return rows[0] ?? null;
  }

  private async requireRow(workspaceId: string): Promise<WorkspaceRow> {
    const row = await this.row(workspaceId);
    if (!row) throw new ApiError(404, 'workspace_not_found', 'Working copy not found');
    return row;
  }

  private async describe(row: WorkspaceRow): Promise<RemoteSession> {
    const workspace = toWorkspace(row, this.link.isOnline(row.agent_id));
    const [restore, session, snapshot] = await Promise.all([
      row.restore_operation_id ? this.restores.get(row.restore_operation_id) : null,
      row.session_id ? this.execution.getSession(row.session_id) : null,
      row.snapshot_operation_id ? this.registrations.get(row.snapshot_operation_id) : null,
    ]);
    return {
      ...workspace,
      restore,
      session,
      snapshot,
      recovery: isAutomatic(row.purpose) ? remoteSessionRecovery(row.state) : null,
    };
  }

  async get(workspaceId: string): Promise<RemoteSession | null> {
    const row = await this.row(workspaceId);
    return row ? this.describe(row) : null;
  }

  private async require(workspaceId: string): Promise<RemoteSession> {
    return this.describe(await this.requireRow(workspaceId));
  }

  /** Active ones first, then the most recent. Historical rows are shown as they were recorded. */
  async list(vm: VmIdentity): Promise<RemoteSession[]> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `${WORKSPACE_QUERY} WHERE w.emulator_type = ? AND w.vm_name = ?
       ORDER BY w.active_marker IS NULL, w.created_at DESC LIMIT 50`,
      [vm.emulatorType, vm.vmName],
    );
    return Promise.all(rows.map((row) => this.describe(row)));
  }

  /**
   * Starts a remote session: a temporary copy of exactly this version, launched as soon as it is ready,
   * then removed or published by itself. A repeated request finds the session it already started. A mode
   * the agent cannot run is refused, never replaced.
   */
  async create(
    vm: VmIdentity,
    input: CreateWorkspaceRequest,
    userId: string,
  ): Promise<RemoteSession> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, vm, input);
    await this.execution.requireRemote(input.agentId, vm, input.mode);
    const workspaceId = randomUUID();
    try {
      await this.restores.create(
        {
          agentId: input.agentId,
          emulatorType: vm.emulatorType,
          vmName: vm.vmName,
          versionId: input.versionId,
        },
        userId,
        { workspaceId, requestId: input.requestId, purpose: input.mode },
      );
    } catch (error) {
      // Two identical requests at once: the loser finds the winner's session.
      const winner = await this.byRequest(input.requestId);
      if (winner) return this.sameRequest(winner, vm, input);
      throw error;
    }
    return this.require(workspaceId);
  }

  private async byRequest(requestId: string): Promise<WorkspaceRow | null> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `${WORKSPACE_QUERY} WHERE w.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private async sameRequest(
    row: WorkspaceRow,
    vm: VmIdentity,
    input: CreateWorkspaceRequest,
  ): Promise<RemoteSession> {
    if (
      row.agent_id !== input.agentId ||
      row.emulator_type !== vm.emulatorType ||
      vmNameKey(row.vm_name) !== vmNameKey(vm.vmName) ||
      row.base_version_id !== input.versionId ||
      row.purpose !== input.mode
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another request.');
    }
    return this.describe(row);
  }

  private refuseAutomatic(row: WorkspaceRow): void {
    if (isAutomatic(row.purpose)) {
      throw new ApiError(
        409,
        'workspace_purpose_mismatch',
        'A remote session launches, publishes and cleans up by itself.',
      );
    }
  }

  /** Launches a Milestone 7 working copy by hand. Remote sessions launch themselves. */
  async launch(workspaceId: string, requestId: string, userId: string): Promise<VmSession> {
    const row = await this.requireRow(workspaceId);
    this.refuseAutomatic(row);
    return this.execution.launch(
      {
        agentId: row.agent_id,
        emulatorType: row.emulator_type,
        vmName: row.vm_name,
        mode: 'remote_snapshot',
        requestId,
        workspaceId,
      },
      userId,
    );
  }

  /**
   * The launch a Milestone 7 working copy asked for when it was requested. Its session's request ID is the
   * working copy's own, so that a repeated commit cannot start two.
   */
  private async launchIfAsked(workspaceId: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT request_id, requested_by_user_id, launch_on_ready, state, purpose FROM vm_workspaces
       WHERE id = ?`,
      [workspaceId],
    );
    const row = rows[0];
    if (!row || row.purpose !== 'manual') return;
    if (!row.launch_on_ready || row.state !== 'ready' || !row.requested_by_user_id) return;
    try {
      await this.launch(
        workspaceId,
        (row.request_id as string | null) ?? randomUUID(),
        row.requested_by_user_id as string,
      );
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal_error';
      const message = error instanceof Error ? error.message : 'The launch failed.';
      await this.pool.execute(
        `UPDATE vm_workspaces SET launch_on_ready = FALSE, error_code = ?, error_message = ?
         WHERE id = ?`,
        [code, message.slice(0, 1024), workspaceId],
      );
    }
  }

  /** Preserves a Milestone 7 working copy by hand, as a child of its current source. */
  async preserve(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<RegistrationOperation> {
    const row = await this.requireRow(workspaceId);
    this.refuseAutomatic(row);
    return this.registrations.createSnapshot(
      { emulatorType: row.emulator_type, vmName: row.vm_name },
      {
        agentId: row.agent_id,
        parentVersionId: row.source_version_id,
        requestId,
        workspaceId,
      },
      userId,
    );
  }

  /**
   * Lets a held remote session go on, once an administrator has checked that its emulator no longer runs
   * on that computer. What follows is what its mode does at the end of a run.
   */
  async resume(workspaceId: string, confirmVmName: string): Promise<RemoteSession> {
    const row = await this.requireRow(workspaceId);
    if (!isAutomatic(row.purpose) || row.state !== 'held') {
      throw new ApiError(
        409,
        'workspace_unavailable',
        'This remote session is not waiting to resume.',
      );
    }
    if (vmNameKey(confirmVmName) !== vmNameKey(row.vm_name)) {
      throw new ApiError(400, 'confirmation_mismatch', 'Type the VM’s name to confirm.');
    }
    const session = row.session_id ? await this.execution.getSession(row.session_id) : null;
    if (session && isSessionActive(session.state)) {
      throw new ApiError(
        409,
        'vm_running',
        'The agent reports this session as running again, so nothing can be published or removed.',
      );
    }
    await this.advance(workspaceId, true);
    return this.require(workspaceId);
  }

  /** Tries a failed Remote Snapshot publication again, now. Nothing can be published twice. */
  async retryPublication(workspaceId: string): Promise<RemoteSession> {
    const row = await this.requireRow(workspaceId);
    if (row.purpose !== 'remote_snapshot' || row.state !== 'publish_failed') {
      throw new ApiError(
        409,
        'workspace_unavailable',
        'Only a Remote Snapshot whose publication failed can be retried.',
      );
    }
    await this.republish(workspaceId);
    await this.advance(workspaceId);
    return this.require(workspaceId);
  }

  /**
   * Asks the agent to remove a working copy. For a Milestone 7 one, as before: unpreserved changes need
   * the VM's name typed. For a remote session, this is how an administrator abandons a snapshot that could
   * not be published, or gives up a held one, and the name is always typed. Refused while anything runs or
   * works on the VM there; the agent checks again. An agent that is away is asked when it returns.
   */
  async discard(workspaceId: string, confirmVmName: string | undefined): Promise<RemoteSession> {
    const before = await this.requireRow(workspaceId);
    if (before.state === 'discarded') return this.describe(before);
    const automatic = isAutomatic(before.purpose);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // The agent's row first, then the working copy's, as a launch takes them: either the launch's
      // session exists when this looks, or this has marked the working copy before the launch looks.
      await connection.execute('SELECT id FROM agents WHERE id = ? FOR UPDATE', [before.agent_id]);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT state, may_have_changes, vm_name FROM vm_workspaces WHERE id = ? FOR UPDATE`,
        [workspaceId],
      );
      const row = rows[0];
      if (!row) throw new ApiError(404, 'workspace_not_found', 'Working copy not found');
      const state = row.state as WorkspaceState;
      const allowed: readonly WorkspaceState[] = automatic
        ? ['ready', 'held', 'publish_failed', 'discarding']
        : ['ready', 'discarding'];
      if (!allowed.includes(state)) {
        throw new ApiError(
          409,
          'workspace_unavailable',
          automatic
            ? 'This remote session is still in progress. It cleans up by itself when it ends.'
            : 'This working copy is not on the agent.',
        );
      }
      const named = vmNameKey(confirmVmName ?? '') === vmNameKey(before.vm_name);
      if (automatic && (state === 'held' || state === 'publish_failed') && !named) {
        throw new ApiError(
          400,
          'confirmation_required',
          state === 'publish_failed'
            ? 'This snapshot was never published, and abandoning it loses this session’s changes. Type the VM’s name to abandon it.'
            : 'Type the VM’s name to confirm that its emulator no longer runs, and to remove this session’s files.',
        );
      }
      if (!automatic && row.may_have_changes && !named) {
        throw new ApiError(
          400,
          'confirmation_required',
          'This working copy may hold changes that are not in any snapshot. Type the VM’s name to discard them.',
        );
      }
      // Unknown sessions count: an emulator that may be running must not lose its files.
      const [busy] = await connection.execute<RowDataPacket[]>(
        `SELECT 'session' AS kind FROM vm_sessions
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1
         UNION ALL SELECT 'operation' FROM registration_operations
           WHERE agent_id = ? AND active_marker = 1
         UNION ALL SELECT 'operation' FROM restore_operations
           WHERE agent_id = ? AND active_marker = 1`,
        [before.agent_id, before.emulator_type, before.vm_name, before.agent_id, before.agent_id],
      );
      if (busy.some((item) => item.kind === 'session')) {
        throw new ApiError(
          409,
          'vm_running',
          'This VM is running on this agent, or may be. Stop it, or dismiss the session, first.',
        );
      }
      if (busy.length > 0) {
        throw new ApiError(
          409,
          'operation_in_progress',
          'This agent is busy with another operation. Wait for it to end.',
        );
      }
      await connection.execute(
        `UPDATE vm_workspaces
         SET abandoned_at = IF(state = 'publish_failed', UTC_TIMESTAMP(3), abandoned_at),
             -- MariaDB assigns in order: the state is read above, before it changes here.
             state = 'discarding',
             discard_requested_at = COALESCE(discard_requested_at, UTC_TIMESTAMP(3)),
             next_retry_at = NULL, error_code = NULL, error_message = NULL
         WHERE id = ?`,
        [workspaceId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (automatic) await this.advance(workspaceId);
    else this.sendDiscard(before);
    return this.require(workspaceId);
  }

  private sendDiscard(row: WorkspaceRow | RowDataPacket): boolean {
    return this.link.send(row.agent_id as string, {
      type: 'server.workspace_discard',
      payload: {
        workspaceId: row.id as string,
        emulatorType: row.emulator_type as VmIdentity['emulatorType'],
        vmName: row.vm_name as string,
      },
    });
  }

  // The remote session lifecycle.

  /** Moves a remote session on, in the background. Errors are logged; the sweep tries again. */
  private kick(workspaceId: string, confirmed = false): void {
    void this.advance(workspaceId, confirmed).catch((error: unknown) => {
      this.log.error({ workspaceId, err: error }, 'Cannot advance a remote session');
    });
  }

  /**
   * Moves a remote session as far as it can go now. Calls for one working copy run one after another in
   * this process; the state guards make concurrent servers safe as well.
   */
  advance(workspaceId: string, confirmed = false): Promise<void> {
    const previous = this.queue.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(workspaceId, confirmed));
    this.queue.set(workspaceId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queue.get(workspaceId) === next) this.queue.delete(workspaceId);
      });
    return next;
  }

  private async run(workspaceId: string, confirmed: boolean): Promise<void> {
    // Each step changes the state, so this ends; the bound only guards against a bug looping forever.
    for (let step = 0; step < 8; step += 1) {
      const row = await this.row(workspaceId);
      if (!row || !isAutomatic(row.purpose)) return;
      if (!(await this.step(row, confirmed))) return;
    }
    this.log.warn({ workspaceId }, 'A remote session took more steps than expected');
  }

  /** One step from the current state. Returns whether the state changed. */
  private async step(row: WorkspaceRow, confirmed: boolean): Promise<boolean> {
    switch (row.state) {
      case 'ready':
        return this.launchSession(row);
      case 'running':
      case 'held':
        return this.afterRun(row, confirmed);
      case 'publishing':
        return this.publish(row);
      case 'publish_failed':
        return row.due ? this.republish(row.id) : false;
      case 'discarding':
        if (this.link.isOnline(row.agent_id) && (row.next_retry_at === null || row.due)) {
          if (this.sendDiscard(row)) {
            await this.pool.execute(
              `UPDATE vm_workspaces
               SET next_retry_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
               WHERE id = ? AND state = 'discarding'`,
              [this.options.discardRetryMs * 1000, row.id],
            );
          }
        }
        return false;
      default:
        return false;
    }
  }

  private async move(
    row: WorkspaceRow,
    from: WorkspaceState,
    to: WorkspaceState,
    error: { code: string; message: string } | null = null,
  ): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE vm_workspaces
       SET state = ?, error_code = ?, error_message = ?, next_retry_at = NULL,
           discard_requested_at = IF(? = 'discarding', COALESCE(discard_requested_at, UTC_TIMESTAMP(3)),
             discard_requested_at)
       WHERE id = ? AND state = ?`,
      [to, error?.code ?? null, error?.message.slice(0, 1024) ?? null, to, row.id, from],
    );
    return result.affectedRows > 0;
  }

  /** The launch, with the working copy's own request ID: a repeated launch finds the same session. */
  private async launchSession(row: WorkspaceRow): Promise<boolean> {
    if (!this.link.isOnline(row.agent_id)) return false;
    try {
      await this.execution.launch(
        {
          agentId: row.agent_id,
          emulatorType: row.emulator_type,
          vmName: row.vm_name,
          mode: row.purpose as RemoteSessionMode,
          requestId: row.request_id ?? row.id,
          workspaceId: row.id,
        },
        row.requested_by_user_id,
      );
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agent_offline') return false;
      // Never started, so the copy is exactly a verified version: nothing to keep, nothing to publish.
      const code = error instanceof ApiError ? error.code : 'internal_error';
      const message = error instanceof Error ? error.message : 'The launch failed.';
      this.log.warn({ workspaceId: row.id, code }, 'A remote session could not be launched');
      return this.move(row, 'ready', 'discarding', { code, message });
    }
  }

  /** What follows the run: nothing while it may run, cleanup or publication when it has ended. */
  private async afterRun(row: WorkspaceRow, confirmed: boolean): Promise<boolean> {
    const session = row.session_id ? await this.execution.getSession(row.session_id) : null;
    const outcome = runOutcome(session);
    if (outcome === 'active') {
      // The agent reported the session again: whatever was decided, it may be running.
      return row.state === 'held' ? this.move(row, 'held', 'running') : false;
    }
    if (outcome === 'never_started') {
      return this.move(row, row.state, 'discarding', session?.error ?? null);
    }
    if (outcome === 'unaccounted' && !confirmed) {
      return row.state === 'held'
        ? false
        : this.move(row, 'running', 'held', {
            code: session?.error?.code ?? 'agent_lost_session',
            message:
              'The session ended without the agent accounting for the emulator. Nothing was published or removed.',
          });
    }
    return this.move(
      row,
      row.state,
      row.purpose === 'remote_snapshot' ? 'publishing' : 'discarding',
    );
  }

  /**
   * Publication of a Remote Snapshot: one snapshot registration of the working copy, whose parent is
   * exactly the version it was started from. It is created under a request ID derived from the attempt,
   * and recorded on the row before the attempt counts, so a crash in between finds the same operation.
   */
  private async publish(row: WorkspaceRow): Promise<boolean> {
    if (row.snapshot_operation_id) {
      const operation = await this.registrations.get(row.snapshot_operation_id);
      if (!operation || !isRegistrationTerminal(operation.state)) return false;
      if (isRegistrationCommitted(operation.state)) {
        const [result] = await this.pool.execute<ResultSetHeader>(
          `UPDATE vm_workspaces
           SET state = 'discarding', next_retry_at = NULL, error_code = NULL, error_message = NULL,
               discard_requested_at = COALESCE(discard_requested_at, UTC_TIMESTAMP(3))
           WHERE id = ? AND state = 'publishing' AND snapshot_operation_id = ?`,
          [row.id, operation.id],
        );
        return result.affectedRows > 0;
      }
      return this.publicationFailed(
        row,
        operation.error ?? { code: 'snapshot_failed', message: 'The snapshot was not published.' },
        false,
      );
    }
    if (!this.link.isOnline(row.agent_id)) return false;
    const attempt = Number(row.publish_attempts);
    let operation: RegistrationOperation;
    try {
      operation = await this.registrations.createSnapshot(
        { emulatorType: row.emulator_type, vmName: row.vm_name },
        {
          agentId: row.agent_id,
          parentVersionId: row.base_version_id,
          requestId: publicationRequestId(row.id, attempt),
          workspaceId: row.id,
        },
        row.requested_by_user_id,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agent_offline') return false;
      const code = error instanceof ApiError ? error.code : 'internal_error';
      const message = error instanceof Error ? error.message : 'The publication could not start.';
      return this.publicationFailed(row, { code, message }, true);
    }
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE vm_workspaces
       SET snapshot_operation_id = ?, publish_attempts = publish_attempts + 1
       WHERE id = ? AND state = 'publishing' AND snapshot_operation_id IS NULL
         AND publish_attempts = ?`,
      [operation.id, row.id, attempt],
    );
    return result.affectedRows > 0;
  }

  /** Keeps the temporary copy, records why, and says when it will be tried again by itself, if ever. */
  private async publicationFailed(
    row: WorkspaceRow,
    error: { code: string; message: string },
    countAttempt: boolean,
  ): Promise<boolean> {
    const attempts = Number(row.publish_attempts) + (countAttempt ? 1 : 0);
    const retry =
      !PERMANENT_PUBLICATION_ERRORS.has(error.code) && attempts < this.options.maxAutomaticAttempts;
    const delays = this.options.publishRetryDelaysMs;
    const delay = delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)] ?? 60_000;
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE vm_workspaces
       SET state = 'publish_failed', publish_attempts = ?, error_code = ?, error_message = ?,
           next_retry_at = IF(?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND), NULL)
       WHERE id = ? AND state = 'publishing' AND snapshot_operation_id <=> ?`,
      [
        attempts,
        error.code,
        error.message.slice(0, 1024),
        retry,
        delay * 1000,
        row.id,
        row.snapshot_operation_id,
      ],
    );
    if (result.affectedRows > 0) {
      this.log.warn({ workspaceId: row.id, code: error.code, retry }, 'A remote snapshot failed');
    }
    return result.affectedRows > 0;
  }

  /** `publish_failed → publishing`, once: of two retries at the same moment, one does nothing. */
  private async republish(workspaceId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE vm_workspaces
       SET state = 'publishing', snapshot_operation_id = NULL, next_retry_at = NULL,
           error_code = NULL, error_message = NULL
       WHERE id = ? AND state = 'publish_failed'`,
      [workspaceId],
    );
    return result.affectedRows > 0;
  }

  /** Every remote session whose next step may be due. Run periodically, and after each welcome. */
  async sweep(agentId?: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM vm_workspaces
       WHERE purpose <> 'manual' AND active_marker = 1 AND state <> 'preparing'
         ${agentId ? 'AND agent_id = ?' : ''}
       ORDER BY created_at`,
      agentId ? [agentId] : [],
    );
    for (const row of rows) {
      await this.advance(row.id as string).catch((error: unknown) => {
        this.log.error({ workspaceId: row.id, err: error }, 'Cannot advance a remote session');
      });
    }
  }

  // What an agent reports.

  /**
   * The working copies the agent holds, after each welcome. A discarded one that is gone is recorded as
   * such, one still there is asked again, and one that is missing is lost. Preparing ones are the
   * restore's business, and end with it. Remote sessions then move on from wherever they are.
   */
  async synced(agentId: string, workspaceIds: readonly string[]): Promise<void> {
    const held = new Set(workspaceIds);
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `${WORKSPACE_QUERY} WHERE w.agent_id = ? AND w.active_marker = 1`,
      [agentId],
    );
    // A working copy recorded as missing that the agent lists again was only missing from a listing: it
    // is on that disk, and only an administrator may decide to remove it.
    const [lost] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, purpose FROM vm_workspaces
       WHERE agent_id = ? AND state = 'lost' AND error_code = 'workspace_missing'`,
      [agentId],
    );
    for (const row of lost) {
      if (!held.has(row.id as string)) continue;
      // A remote session back from the dead waits for an administrator: it may hold an unpublished
      // snapshot, and its emulator's fate is not known.
      const state = row.purpose === 'manual' ? 'ready' : 'held';
      try {
        await this.pool.execute(
          `UPDATE vm_workspaces SET state = ?, finished_at = NULL, error_code = NULL,
             error_message = NULL
           WHERE id = ? AND state = 'lost'`,
          [state, row.id],
        );
      } catch (error) {
        // Another working copy of the VM is active here now. This one stays lost, and is reported.
        this.log.warn({ agentId, workspaceId: row.id, err: error }, 'A lost working copy is back');
      }
    }
    const known = new Set([...rows.map((row) => row.id), ...lost.map((row) => row.id as string)]);
    for (const workspaceId of held) {
      if (!known.has(workspaceId)) {
        this.log.warn(
          { agentId, workspaceId },
          'The agent holds a working copy this server does not',
        );
      }
    }
    for (const row of rows) {
      const present = held.has(row.id);
      if (row.state === 'preparing') continue;
      if (row.state === 'discarding') {
        if (present) this.sendDiscard(row);
        else await this.finish(row.id, 'discarded', null, null);
        continue;
      }
      if (present) continue;
      if (row.purpose === 'manual' && row.state !== 'ready') continue;
      // Published before its files went: the session did what it was for.
      if (row.snapshot_version_id !== null) {
        await this.finish(row.id, 'discarded', null, null);
        continue;
      }
      await this.finish(
        row.id,
        'lost',
        'workspace_missing',
        'The agent no longer has this working copy.',
      );
    }
    await this.sweep(agentId);
  }

  async discardResult(agentId: string, payload: WorkspaceDiscardResultPayload): Promise<void> {
    if (payload.removed) {
      await this.pool.execute(
        `UPDATE vm_workspaces SET state = 'discarded', finished_at = UTC_TIMESTAMP(3),
           next_retry_at = NULL, error_code = NULL, error_message = NULL
         WHERE id = ? AND agent_id = ?
           AND (state = 'discarding' OR (purpose = 'manual' AND state = 'ready'))`,
        [payload.workspaceId, agentId],
      );
      return;
    }
    const code = payload.code ?? 'discard_failed';
    const message = payload.message ?? 'The agent could not remove the working copy.';
    // Refused or incomplete: it is still there. A Milestone 7 one can be discarded again by hand; a
    // remote session asks again by itself, since nothing in it is wanted any more.
    await this.pool.execute(
      `UPDATE vm_workspaces
       SET state = IF(purpose = 'manual', 'ready', state), error_code = ?, error_message = ?,
           next_retry_at = IF(purpose = 'manual', NULL,
             DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))
       WHERE id = ? AND agent_id = ? AND state = 'discarding'`,
      [code, message, this.options.discardRetryMs * 1000, payload.workspaceId, agentId],
    );
  }

  /** Revocation says nothing about the agent's disk. Its working copies are lost to this server. */
  async agentRevoked(agentId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_workspaces SET state = 'lost', finished_at = UTC_TIMESTAMP(3), next_retry_at = NULL,
         error_code = 'agent_revoked',
         error_message = 'The agent was revoked. Its working copy may still be on that computer.'
       WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
  }

  private async finish(
    workspaceId: string,
    state: 'discarded' | 'lost',
    code: string | null,
    message: string | null,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_workspaces SET state = ?, finished_at = UTC_TIMESTAMP(3), next_retry_at = NULL,
         error_code = ?, error_message = ?
       WHERE id = ? AND active_marker = 1`,
      [state, code, message, workspaceId],
    );
  }
}
