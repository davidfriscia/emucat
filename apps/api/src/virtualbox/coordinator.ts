import { randomUUID } from 'node:crypto';
import {
  executionRecovery,
  isVirtualBoxActive,
  VIRTUALBOX_ENDED_STATES,
  type ServerMessage,
  type VirtualBoxControlAction,
  type VirtualBoxControlResultPayload,
  type VirtualBoxObservation,
  type VirtualBoxSource,
  type VirtualBoxStatesPayload,
  type VirtualBoxVmState,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

/** What the coordinator needs from the hub, which owns the sockets. */
export interface VirtualBoxLink {
  isOnline(agentId: string): boolean;
  isVirtualBoxCapable(agentId: string): boolean;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

export interface VirtualBoxOptions {
  /** How long a launch may stay unanswered before it is given up. */
  answerTimeoutMs: number;
}

const DEFAULT_OPTIONS: VirtualBoxOptions = { answerTimeoutMs: 120_000 };

interface SourceRow extends RowDataPacket {
  vm_name: string;
  agent_id: string;
  agent_name: string;
  machine_uuid: string;
  display_name: string;
  state: VirtualBoxVmState | null;
  raw_state: string | null;
  present: number | null;
  is_accessible: number | null;
  observed_at: Date | null;
}

const SOURCE_QUERY = `
  SELECT src.vm_name, src.agent_id, a.name AS agent_name, src.machine_uuid, src.display_name,
         src.state, src.raw_state, src.present, src.is_accessible, src.observed_at
  FROM virtualbox_sources AS src
  JOIN agents AS a ON a.id = src.agent_id`;

const toBoolean = (value: number | null): boolean | null => (value === null ? null : value !== 0);

const isDuplicateEntry = (error: unknown): boolean =>
  (error as { code?: string }).code === 'ER_DUP_ENTRY';

/**
 * Registered VirtualBox machines on the server's side (decision 0045). The agent watches them, and this keeps
 * `virtualbox_sources` and `vm_sessions` in line with what it observes. A session is never moved because a
 * command succeeded, only because a machine was seen in a state: VirtualBox can start and stop a machine without
 * EmuCat, and a command that VirtualBox accepted may still not have the effect it asked for.
 *
 * Like the other coordinators it keeps nothing in memory, and every handler is idempotent.
 */
export class VirtualBoxCoordinator {
  private readonly options: VirtualBoxOptions;

  constructor(
    private readonly pool: Pool,
    private readonly link: VirtualBoxLink,
    private readonly log: FastifyBaseLogger,
    options: Partial<VirtualBoxOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Tells the agent which machines to watch: every one registered for it. Its answer is a complete report. */
  async watch(agentId: string): Promise<void> {
    if (!this.link.isVirtualBoxCapable(agentId)) return;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT machine_uuid FROM virtualbox_sources WHERE agent_id = ? ORDER BY machine_uuid',
      [agentId],
    );
    this.link.send(agentId, {
      type: 'server.virtualbox_watch',
      payload: { machines: rows.map((row) => row.machine_uuid as string) },
    });
  }

  /** Where a VirtualBox VM's machine is, and what it was last seen doing. */
  async source(vm: VmIdentity): Promise<VirtualBoxSource | null> {
    if (vm.emulatorType !== 'virtualbox') return null;
    const [rows] = await this.pool.execute<SourceRow[]>(`${SOURCE_QUERY} WHERE src.vm_name = ?`, [
      vm.vmName,
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      machineUuid: row.machine_uuid,
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentOnline: this.link.isOnline(row.agent_id),
      displayName: row.display_name,
      state: row.state,
      rawState: row.raw_state,
      present: toBoolean(row.present),
      accessible: toBoolean(row.is_accessible),
      observedAt: row.observed_at?.toISOString() ?? null,
    };
  }

  /** Sends a start or a stop. It changes no session: the observation that follows does. */
  control(
    agentId: string,
    sessionId: string,
    machineUuid: string,
    action: VirtualBoxControlAction,
  ): boolean {
    return this.link.send(agentId, {
      type: 'server.virtualbox_control',
      payload: { sessionId, machineUuid, action },
    });
  }

  // What an agent reports. Its identity comes from its connection, and nowhere else.

  async states(agentId: string, payload: VirtualBoxStatesPayload): Promise<void> {
    if (!payload.available) {
      this.log.warn({ agentId }, 'The agent cannot run VBoxManage; VirtualBox states are unknown');
    }
    for (const observation of payload.machines) {
      await this.observed(agentId, observation);
    }
    if (payload.complete) await this.expireLaunches(agentId);
  }

  /** One machine's observation: the source row, then its session. In one transaction, with the session locked. */
  private async observed(agentId: string, observation: VirtualBoxObservation): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [sources] = await connection.execute<RowDataPacket[]>(
        `SELECT vm_name FROM virtualbox_sources WHERE agent_id = ? AND machine_uuid = ? FOR UPDATE`,
        [agentId, observation.machineUuid],
      );
      const vmName = sources[0]?.vm_name as string | undefined;
      if (!vmName) {
        // Not registered for this agent: nothing here is about it.
        await connection.rollback();
        return;
      }
      await connection.execute(
        `UPDATE virtualbox_sources
         SET present = ?, is_accessible = ?, state = ?, raw_state = ?, state_changed_at = ?,
             observed_at = ?, display_name = COALESCE(?, display_name)
         WHERE agent_id = ? AND machine_uuid = ?`,
        [
          observation.present,
          observation.present ? observation.accessible : null,
          observation.present ? observation.state : null,
          observation.present ? observation.rawState : null,
          observation.stateChangedAt ? new Date(observation.stateChangedAt) : null,
          new Date(observation.observedAt),
          observation.present ? observation.name : null,
          agentId,
          observation.machineUuid,
        ],
      );
      await this.reconcileIn(connection, agentId, vmName, observation);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async reconcileIn(
    connection: PoolConnection,
    agentId: string,
    vmName: string,
    observation: VirtualBoxObservation,
  ): Promise<void> {
    const [sessions] = await connection.execute<RowDataPacket[]>(
      `SELECT id, execution_state, stop_requested_at, force_requested_at FROM vm_sessions
       WHERE agent_id = ? AND emulator_type = 'virtualbox' AND vm_name = ? AND active_marker = 1
       FOR UPDATE`,
      [agentId, vmName],
    );
    const session = sessions[0];
    const sessionState = session?.execution_state as string | undefined;

    if (!observation.present) {
      if (session) {
        await this.end(connection, session.id as string, 'interrupted', 'source_unavailable');
      }
      return;
    }
    if (isVirtualBoxActive(observation.state)) {
      const startedAt = observation.stateChangedAt
        ? new Date(observation.stateChangedAt)
        : new Date();
      if (session) {
        // A stop that was asked for is still under way until the machine is seen to end.
        const next =
          observation.state === 'stopping' || session.stop_requested_at ? 'stopping' : 'running';
        await connection.execute(
          `UPDATE vm_sessions
           SET execution_state = ?, started_at = COALESCE(started_at, ?), graceful_stop_available = TRUE
           WHERE id = ? AND active_marker = 1`,
          [next, startedAt, session.id],
        );
        return;
      }
      // Started outside EmuCat, or while the server was away. It is running, so it is a session.
      const [states] = await connection.execute<RowDataPacket[]>(
        `SELECT local_source_version_id FROM agent_vm_state
         WHERE agent_id = ? AND emulator_type = 'virtualbox' AND vm_name = ?`,
        [agentId, vmName],
      );
      try {
        await connection.execute(
          `INSERT INTO vm_sessions
             (id, agent_id, user_id, request_id, emulator_type, vm_name, source_version_id, mode,
              execution_state, started_at, graceful_stop_available)
           VALUES (?, ?, NULL, NULL, 'virtualbox', ?, ?, 'local', 'running', ?, TRUE)`,
          [
            randomUUID(),
            agentId,
            vmName,
            (states[0]?.local_source_version_id as string | null | undefined) ?? null,
            startedAt,
          ],
        );
      } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
      }
      return;
    }
    if (VIRTUALBOX_ENDED_STATES.includes(observation.state) && session) {
      // A launch VirtualBox has not accepted yet may not have reached it: only its answer, or its time limit,
      // ends it. Anything later is over once the machine is seen not running.
      if (sessionState === 'requested') return;
      const forced = session.force_requested_at !== null;
      const stopped = session.stop_requested_at !== null;
      const aborted = observation.state === 'aborted';
      await this.end(
        connection,
        session.id as string,
        aborted && !forced ? 'failed' : stopped ? 'stopped' : 'exited',
        aborted && !forced ? 'vm_aborted' : forced ? 'forced' : null,
      );
    }
    // Busy, inaccessible or unknown says nothing about whether the machine runs. The session stays as it is.
  }

  private async end(
    connection: PoolConnection,
    sessionId: string,
    state: 'stopped' | 'exited' | 'failed' | 'interrupted',
    code: string | null,
  ): Promise<void> {
    await connection.execute(
      `UPDATE vm_sessions
       SET execution_state = ?, ended_at = UTC_TIMESTAMP(3), error_code = ?, error_message = ?
       WHERE id = ? AND active_marker = 1`,
      [state, code, code ? (executionRecovery(code) ?? code) : null, sessionId],
    );
  }

  /** Launches nobody answered in time. Nothing was started, as far as anyone can tell. */
  private async expireLaunches(agentId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_sessions
       SET execution_state = 'failed', ended_at = UTC_TIMESTAMP(3), error_code = 'launch_not_acknowledged',
           error_message = ?
       WHERE agent_id = ? AND emulator_type = 'virtualbox' AND active_marker = 1
         AND execution_state = 'requested' AND created_at < ?`,
      [
        executionRecovery('launch_not_acknowledged'),
        agentId,
        new Date(Date.now() - this.options.answerTimeoutMs),
      ],
    );
  }

  /**
   * What VirtualBox said to a command. A refusal is recorded; an acceptance only moves a launch from requested
   * to starting, since nothing has been seen yet.
   */
  async controlResult(agentId: string, payload: VirtualBoxControlResultPayload): Promise<void> {
    const { sessionId, action, accepted } = payload;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT s.execution_state, src.machine_uuid FROM vm_sessions AS s
       JOIN virtualbox_sources AS src ON src.vm_name = s.vm_name AND src.agent_id = s.agent_id
       WHERE s.id = ? AND s.agent_id = ? AND s.emulator_type = 'virtualbox'`,
      [sessionId, agentId],
    );
    const row = rows[0];
    if (!row || row.machine_uuid !== payload.machineUuid) {
      this.log.warn({ agentId, sessionId }, 'A VirtualBox control result for an unknown session');
      return;
    }
    const code = payload.code ?? 'control_refused';
    const message = payload.message ?? executionRecovery(code) ?? code;
    if (action === 'start') {
      if (accepted) {
        await this.pool.execute(
          `UPDATE vm_sessions SET execution_state = 'starting', graceful_stop_available = TRUE
           WHERE id = ? AND execution_state = 'requested'`,
          [sessionId],
        );
      } else {
        await this.pool.execute(
          `UPDATE vm_sessions
           SET execution_state = 'failed', ended_at = UTC_TIMESTAMP(3), error_code = ?, error_message = ?
           WHERE id = ? AND execution_state IN ('requested', 'starting')`,
          [code, message, sessionId],
        );
      }
      return;
    }
    if (!accepted) {
      // The machine runs on: the stop did not happen. A forced stop can still be asked for.
      await this.pool.execute(
        `UPDATE vm_sessions
         SET execution_state = IF(execution_state = 'stopping', 'running', execution_state),
             stop_requested_at = NULL, force_requested_at = NULL, error_code = ?, error_message = ?
         WHERE id = ? AND active_marker = 1`,
        [code, message, sessionId],
      );
    }
  }
}
