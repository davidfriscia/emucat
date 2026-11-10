import { randomUUID } from 'node:crypto';
import {
  vmNameKey,
  type CreateWorkspaceRequest,
  type RegistrationOperation,
  type ServerMessage,
  type VmIdentity,
  type VmSession,
  type VmWorkspace,
  type WorkspaceDiscardResultPayload,
  type WorkspaceState,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';
import type { ExecutionCoordinator } from '../execution/coordinator.js';
import type { RegistrationCoordinator } from '../registration/coordinator.js';
import type { RestoreCoordinator } from '../restore/coordinator.js';

export interface WorkspaceLink {
  isOnline(agentId: string): boolean;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

interface WorkspaceRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  requested_by_display_name: string | null;
  request_id: string | null;
  emulator_type: VmWorkspace['emulatorType'];
  vm_name: string;
  state: WorkspaceState;
  base_version_id: string;
  source_version_id: string;
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
  SELECT w.id, w.agent_id, a.name AS agent_name, u.display_name AS requested_by_display_name,
         w.request_id, w.emulator_type, w.vm_name, w.state, w.base_version_id, w.source_version_id,
         w.may_have_changes, w.launch_on_ready, w.local_directory, w.error_code, w.error_message,
         w.created_at, w.updated_at, w.finished_at,
         (SELECT op.id FROM restore_operations AS op WHERE op.workspace_id = w.id
           ORDER BY op.created_at DESC LIMIT 1) AS restore_operation_id
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
    state: row.state,
    baseVersionId: row.base_version_id,
    sourceVersionId: row.source_version_id,
    mayHaveChanges: row.may_have_changes !== 0,
    launchOnReady: row.launch_on_ready !== 0,
    restoreOperationId: row.restore_operation_id,
    localDirectory: row.local_directory,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    requestedByDisplayName: row.requested_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/**
 * Remote Snapshot working copies on the server's side (decision 0038). Preparing one is a restore,
 * running it is a session, and preserving it is a snapshot: this coordinator only ties them together and
 * owns the one thing that is new, discarding. Nothing here publishes or deletes on its own: a stopped
 * session leaves a working copy ready, and only an administrator decides what becomes of it.
 */
export class WorkspaceCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly link: WorkspaceLink,
    private readonly log: FastifyBaseLogger,
    private readonly restores: RestoreCoordinator,
    private readonly execution: ExecutionCoordinator,
    private readonly registrations: RegistrationCoordinator,
  ) {
    restores.onWorkspaceReady = (workspaceId) => {
      void this.launchIfAsked(workspaceId).catch((error: unknown) => {
        this.log.error({ workspaceId, err: error }, 'Cannot launch a ready working copy');
      });
    };
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

  async get(workspaceId: string): Promise<VmWorkspace | null> {
    const row = await this.row(workspaceId);
    return row ? toWorkspace(row, this.link.isOnline(row.agent_id)) : null;
  }

  async list(vm: VmIdentity): Promise<VmWorkspace[]> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `${WORKSPACE_QUERY} WHERE w.emulator_type = ? AND w.vm_name = ?
       ORDER BY w.active_marker IS NULL, w.created_at DESC LIMIT 50`,
      [vm.emulatorType, vm.vmName],
    );
    return rows.map((row) => toWorkspace(row, this.link.isOnline(row.agent_id)));
  }

  /**
   * Prepares a working copy of any version on an agent, through a restore into it. A repeated request
   * finds the working copy it already created. With `launch`, it starts once the restore has committed.
   */
  async create(
    vm: VmIdentity,
    input: CreateWorkspaceRequest,
    userId: string,
  ): Promise<VmWorkspace> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, vm, input);
    if (!this.link.isOnline(input.agentId)) {
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
    // Refused, never replaced by a local launch or a volatile session.
    if (!this.execution.canRunRemoteSnapshot(input.agentId)) {
      throw new ApiError(
        409,
        'execution_mode_unavailable',
        'This agent cannot run Remote Snapshot sessions. Update it. Nothing was prepared.',
      );
    }
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
        { workspaceId, requestId: input.requestId, launchOnReady: input.launch },
      );
    } catch (error) {
      // Two identical requests at once: the loser finds the winner's working copy.
      const winner = await this.byRequest(input.requestId);
      if (winner) return this.sameRequest(winner, vm, input);
      throw error;
    }
    const row = await this.requireRow(workspaceId);
    return toWorkspace(row, this.link.isOnline(row.agent_id));
  }

  private async byRequest(requestId: string): Promise<WorkspaceRow | null> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `${WORKSPACE_QUERY} WHERE w.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private sameRequest(
    row: WorkspaceRow,
    vm: VmIdentity,
    input: CreateWorkspaceRequest,
  ): VmWorkspace {
    if (
      row.agent_id !== input.agentId ||
      row.emulator_type !== vm.emulatorType ||
      vmNameKey(row.vm_name) !== vmNameKey(vm.vmName) ||
      row.base_version_id !== input.versionId
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another request.');
    }
    return toWorkspace(row, this.link.isOnline(row.agent_id));
  }

  async launch(workspaceId: string, requestId: string, userId: string): Promise<VmSession> {
    const row = await this.requireRow(workspaceId);
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
   * The launch asked for when the working copy was requested. Its session's request ID is the working
   * copy's own, so that a repeated commit cannot start two. A refusal leaves the working copy ready, with
   * the reason, and an administrator can launch it again.
   */
  private async launchIfAsked(workspaceId: string): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT request_id, requested_by_user_id, launch_on_ready, state FROM vm_workspaces
       WHERE id = ?`,
      [workspaceId],
    );
    const row = rows[0];
    if (!row || !row.launch_on_ready || row.state !== 'ready' || !row.requested_by_user_id) return;
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

  /** A new immutable snapshot of what the working copy holds, as a child of its current source. */
  async preserve(
    workspaceId: string,
    requestId: string,
    userId: string,
  ): Promise<RegistrationOperation> {
    const row = await this.requireRow(workspaceId);
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
   * Asks the agent to remove the working copy. Unpreserved changes are lost, so when there may be some
   * the VM's name must be typed. Refused while anything runs or works on the VM there; the agent checks
   * again. An agent that is away is asked when it returns.
   */
  async discard(workspaceId: string, confirmVmName: string | undefined): Promise<VmWorkspace> {
    const before = await this.requireRow(workspaceId);
    if (before.state === 'discarded')
      return toWorkspace(before, this.link.isOnline(before.agent_id));
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
      if (row.state !== 'ready' && row.state !== 'discarding') {
        throw new ApiError(409, 'workspace_unavailable', 'This working copy is not on the agent.');
      }
      if (row.may_have_changes && vmNameKey(confirmVmName ?? '') !== vmNameKey(before.vm_name)) {
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
         SET state = 'discarding',
             discard_requested_at = COALESCE(discard_requested_at, UTC_TIMESTAMP(3)),
             error_code = NULL, error_message = NULL
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
    this.sendDiscard(before);
    const after = await this.requireRow(workspaceId);
    return toWorkspace(after, this.link.isOnline(after.agent_id));
  }

  private sendDiscard(row: WorkspaceRow | RowDataPacket): void {
    this.link.send(row.agent_id as string, {
      type: 'server.workspace_discard',
      payload: {
        workspaceId: row.id as string,
        emulatorType: row.emulator_type as VmIdentity['emulatorType'],
        vmName: row.vm_name as string,
      },
    });
  }

  // What an agent reports.

  /**
   * The working copies the agent holds, after each welcome. A discarded one that is gone is recorded as
   * such, one still there is asked again, and a ready one that is missing is lost. Preparing ones are the
   * restore's business, and end with it.
   */
  async synced(agentId: string, workspaceIds: readonly string[]): Promise<void> {
    const held = new Set(workspaceIds);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, agent_id, emulator_type, vm_name, state FROM vm_workspaces
       WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
    // A working copy recorded as missing that the agent lists again was only missing from a listing: it
    // is on that disk, and only an administrator may decide to remove it.
    const [lost] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM vm_workspaces
       WHERE agent_id = ? AND state = 'lost' AND error_code = 'workspace_missing'`,
      [agentId],
    );
    for (const row of lost) {
      if (!held.has(row.id as string)) continue;
      try {
        await this.pool.execute(
          `UPDATE vm_workspaces SET state = 'ready', finished_at = NULL, error_code = NULL,
             error_message = NULL
           WHERE id = ? AND state = 'lost'`,
          [row.id],
        );
      } catch (error) {
        // Another working copy of the VM is active here now. This one stays lost, and is reported.
        this.log.warn({ agentId, workspaceId: row.id, err: error }, 'A lost working copy is back');
      }
    }
    const known = new Set([...rows, ...lost].map((row) => row.id as string));
    for (const workspaceId of held) {
      if (!known.has(workspaceId)) {
        this.log.warn(
          { agentId, workspaceId },
          'The agent holds a working copy this server does not',
        );
      }
    }
    for (const row of rows) {
      const workspaceId = row.id as string;
      if (row.state === 'discarding') {
        if (held.has(workspaceId)) this.sendDiscard(row);
        else await this.finish(workspaceId, 'discarded', null, null);
      } else if (row.state === 'ready' && !held.has(workspaceId)) {
        await this.finish(
          workspaceId,
          'lost',
          'workspace_missing',
          'The agent no longer has this working copy.',
        );
      }
    }
  }

  async discardResult(agentId: string, payload: WorkspaceDiscardResultPayload): Promise<void> {
    if (payload.removed) {
      await this.pool.execute(
        `UPDATE vm_workspaces SET state = 'discarded', finished_at = UTC_TIMESTAMP(3),
           error_code = NULL, error_message = NULL
         WHERE id = ? AND agent_id = ? AND state IN ('discarding', 'ready')`,
        [payload.workspaceId, agentId],
      );
    } else {
      // Refused or incomplete: it is still there, and can be discarded again.
      await this.pool.execute(
        `UPDATE vm_workspaces SET state = 'ready', error_code = ?, error_message = ?
         WHERE id = ? AND agent_id = ? AND state = 'discarding'`,
        [
          payload.code ?? 'discard_failed',
          payload.message ?? 'The agent could not remove the working copy.',
          payload.workspaceId,
          agentId,
        ],
      );
    }
  }

  /** Revocation says nothing about the agent's disk. Its working copies are lost to this server. */
  async agentRevoked(agentId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_workspaces SET state = 'lost', finished_at = UTC_TIMESTAMP(3),
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
      `UPDATE vm_workspaces SET state = ?, finished_at = UTC_TIMESTAMP(3), error_code = ?,
         error_message = ?
       WHERE id = ? AND active_marker = 1`,
      [state, code, message, workspaceId],
    );
  }
}
