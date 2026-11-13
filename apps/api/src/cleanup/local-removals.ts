import { randomUUID } from 'node:crypto';
import {
  localRemovalRecovery,
  REMOVAL_INELIGIBLE_TEXT,
  type CreateLocalCopyRemovalRequest,
  type LocalCopyRemovePayload,
  type LocalCopyRemoveResultPayload,
  type LocalCopyRemoval,
  type LocalRemovalState,
  type RemovalIneligibleReason,
  type RestoreSyncPayload,
  type ServerMessage,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ApiError } from '../errors.js';

/** What the coordinator needs from the hub, which owns the sockets. */
export interface CleanupLink {
  isOnline(agentId: string): boolean;
  restoreCapabilities(agentId: string): RestoreSyncPayload['capabilities'] | null;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

interface RemovalRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  requested_by_display_name: string | null;
  emulator_type: LocalCopyRemoval['emulatorType'];
  vm_name: string;
  expected_version_id: string | null;
  discard_local_changes: number;
  state: LocalRemovalState;
  accepted_at: Date | null;
  cleanup_pending: number;
  local_directory: string | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const REMOVAL_QUERY = `
  SELECT op.id, op.agent_id, a.name AS agent_name, u.display_name AS requested_by_display_name,
         op.emulator_type, op.vm_name, op.expected_version_id, op.discard_local_changes, op.state,
         op.accepted_at, op.cleanup_pending, op.local_directory, op.error_code, op.error_message,
         op.finished_at, op.created_at, op.updated_at
  FROM local_copy_removals AS op
  JOIN agents AS a ON a.id = op.agent_id
  LEFT JOIN users AS u ON u.id = op.requested_by_user_id`;

const FAILURE_TEXT: Record<string, string> = {
  agent_revoked: 'The agent was revoked before this finished.',
  agent_lost_operation:
    'The agent no longer knows about this removal. The local copy may still be there.',
  invalid_result: 'The agent reported a result that does not belong to this removal.',
};

function toRemoval(row: RemovalRow, online: boolean): LocalCopyRemoval {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentOnline: online,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    expectedVersionId: row.expected_version_id,
    discardLocalChanges: row.discard_local_changes !== 0,
    state: row.state,
    cleanupPending: row.cleanup_pending !== 0,
    localDirectory: row.local_directory,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    recovery: row.error_code ? localRemovalRecovery(row.error_code) : null,
    requestedByDisplayName: row.requested_by_display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function commandFor(row: RemovalRow): LocalCopyRemovePayload {
  return {
    operationId: row.id,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    expectedVersionId: row.expected_version_id,
    discardLocalChanges: row.discard_local_changes !== 0,
  };
}

const isDuplicateEntry = (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY';

function refuse(reason: RemovalIneligibleReason): ApiError {
  return new ApiError(409, reason, REMOVAL_INELIGIBLE_TEXT[reason]);
}

/** What decides whether an agent's persistent copy of a VM can be removed now. */
export interface RemovalFacts {
  revoked: boolean;
  /** `agent_vm_state.execution_state`, or `null` with no row. */
  localState: string | null;
  running: boolean;
  busy: boolean;
}

/**
 * Why an agent's persistent copy cannot be removed now, or `null` if it can. The interface shows this;
 * `create` decides it again under the agent's row lock, and the agent checks everything again on its disk.
 */
export function removalIneligible(
  link: CleanupLink,
  agentId: string,
  facts: RemovalFacts,
): RemovalIneligibleReason | null {
  if (facts.revoked) return 'agent_revoked';
  if (!link.isOnline(agentId)) return 'agent_offline';
  if (link.restoreCapabilities(agentId)?.removeLocal !== true) return 'agent_cannot_remove';
  if (facts.localState === null || facts.localState === 'absent') return 'no_local_copy';
  if (facts.running) return 'vm_running';
  if (facts.busy) return 'operation_in_progress';
  return null;
}

/**
 * SQL counting what keeps an agent busy for a removal, for one agent: anything that works on its disk.
 * Takes the agent ID five times.
 */
export const AGENT_DISK_WORK = `
  (SELECT COUNT(*) FROM restore_operations WHERE agent_id = ? AND active_marker = 1) +
  (SELECT COUNT(*) FROM registration_operations WHERE agent_id = ? AND active_marker = 1) +
  (SELECT COUNT(*) FROM vm_verifications WHERE agent_id = ? AND active_marker = 1) +
  (SELECT COUNT(*) FROM vm_workspaces WHERE agent_id = ? AND state IN ('preparing', 'discarding')) +
  (SELECT COUNT(*) FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1)`;

/**
 * Removing one agent's persistent copy of a VM (decision 0041). It holds no state of its own: everything is
 * in `local_copy_removals`. The command is sent only until the agent has said it holds it, so a lost state
 * directory can never turn an old request into a new deletion.
 */
export class LocalCopyRemovalCoordinator {
  constructor(
    private readonly pool: Pool,
    private readonly link: CleanupLink,
    private readonly log: FastifyBaseLogger,
  ) {}

  async create(input: CreateLocalCopyRemovalRequest, userId: string): Promise<LocalCopyRemoval> {
    const repeated = await this.byRequest(input.requestId);
    if (repeated) return this.sameRequest(repeated, input);

    const { agentId, emulatorType, vmName, expectedVersionId, discardLocalChanges } = input;
    if (!this.link.isOnline(agentId)) throw refuse('agent_offline');
    if (this.link.restoreCapabilities(agentId)?.removeLocal !== true) {
      throw refuse('agent_cannot_remove');
    }

    const operationId = randomUUID();
    let command: LocalCopyRemovePayload;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Exclusive, as a restore's: registration and snapshots take it shared, launch, restore and
      // verification exclusively, so none of them can be created alongside this.
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? FOR UPDATE',
        [agentId],
      );
      const agent = agents[0];
      if (!agent || !agent.paired_at) throw new ApiError(404, 'agent_not_found', 'Agent not found');
      if (agent.revoked_at) throw refuse('agent_revoked');
      const [vms] = await connection.execute<RowDataPacket[]>(
        'SELECT vm_name FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
        [emulatorType, vmName],
      );
      if (!vms[0]) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
      const canonicalName = vms[0].vm_name as string;

      const [states] = await connection.execute<RowDataPacket[]>(
        `SELECT execution_state, content_status, local_source_version_id FROM agent_vm_state
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
        [agentId, emulatorType, canonicalName],
      );
      const state = states[0];
      // Unknown sessions count: an emulator that may be running must not lose its disk.
      const [sessions] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM vm_sessions
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [agentId, emulatorType, canonicalName],
      );
      const [work] = await connection.execute<RowDataPacket[]>(
        `SELECT ${AGENT_DISK_WORK} AS work`,
        [agentId, agentId, agentId, agentId, agentId],
      );
      const reason = removalIneligible(this.link, agentId, {
        revoked: false,
        localState: (state?.execution_state as string | undefined) ?? null,
        running: sessions.length > 0,
        busy: Number(work[0]?.work) > 0,
      });
      if (reason) throw refuse(reason);
      const recorded = (state?.local_source_version_id as string | null | undefined) ?? null;
      if (recorded !== expectedVersionId) {
        throw new ApiError(
          409,
          'local_copy_changed',
          'The local copy is no longer the one this page showed. Reload, and check what it is now.',
        );
      }
      if (state?.content_status === 'modified' && !discardLocalChanges) {
        throw new ApiError(
          409,
          'local_copy_modified',
          'The local copy has changes that are in no version. Snapshot it first, or confirm that they are lost.',
        );
      }

      command = {
        operationId,
        emulatorType,
        vmName: canonicalName,
        expectedVersionId,
        discardLocalChanges,
      };
      try {
        await connection.execute(
          `INSERT INTO local_copy_removals
             (id, agent_id, requested_by_user_id, request_id, emulator_type, vm_name,
              expected_version_id, discard_local_changes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            agentId,
            userId,
            input.requestId,
            emulatorType,
            canonicalName,
            expectedVersionId,
            discardLocalChanges,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          const message = (error as { message?: string }).message ?? '';
          if (message.includes('uq_local_copy_removals_request')) throw new RepeatedRequest();
          throw refuse('operation_in_progress');
        }
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error instanceof RepeatedRequest) {
        const winner = await this.byRequest(input.requestId);
        if (winner) return this.sameRequest(winner, input);
      }
      throw error;
    } finally {
      connection.release();
    }

    // If this is not delivered, it goes out again after the agent's next welcome.
    this.link.send(agentId, { type: 'server.local_copy_remove', payload: command });
    return this.require(operationId);
  }

  private async byRequest(requestId: string): Promise<RemovalRow | null> {
    const [rows] = await this.pool.execute<RemovalRow[]>(
      `${REMOVAL_QUERY} WHERE op.request_id = ?`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  private sameRequest(row: RemovalRow, input: CreateLocalCopyRemovalRequest): LocalCopyRemoval {
    if (
      row.agent_id !== input.agentId ||
      row.emulator_type !== input.emulatorType ||
      row.vm_name.toLowerCase() !== input.vmName.toLowerCase() ||
      row.expected_version_id !== input.expectedVersionId ||
      (row.discard_local_changes !== 0) !== input.discardLocalChanges
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another operation.');
    }
    return toRemoval(row, this.link.isOnline(row.agent_id));
  }

  async get(operationId: string): Promise<LocalCopyRemoval | null> {
    const [rows] = await this.pool.execute<RemovalRow[]>(`${REMOVAL_QUERY} WHERE op.id = ?`, [
      operationId,
    ]);
    return rows[0] ? toRemoval(rows[0], this.link.isOnline(rows[0].agent_id)) : null;
  }

  private async require(operationId: string): Promise<LocalCopyRemoval> {
    const removal = await this.get(operationId);
    if (!removal) throw new ApiError(404, 'removal_not_found', 'Removal not found');
    return removal;
  }

  async list(filter: {
    agentId?: string | undefined;
    emulatorType?: string | undefined;
    vmName?: string | undefined;
  }): Promise<LocalCopyRemoval[]> {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.agentId) {
      conditions.push('op.agent_id = ?');
      values.push(filter.agentId);
    }
    if (filter.emulatorType) {
      conditions.push('op.emulator_type = ?');
      values.push(filter.emulatorType);
    }
    if (filter.vmName) {
      conditions.push('op.vm_name = ?');
      values.push(filter.vmName);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.pool.execute<RemovalRow[]>(
      `${REMOVAL_QUERY} ${where} ORDER BY op.created_at DESC, op.id LIMIT 100`,
      values,
    );
    return rows.map((row) => toRemoval(row, this.link.isOnline(row.agent_id)));
  }

  // What an agent reports. The agent's identity comes from its connection, and nowhere else.

  private ack(agentId: string, operationId: string, outcome: 'closed' | 'rejected'): void {
    this.link.send(agentId, {
      type: 'server.local_copy_remove_ack',
      payload: { operationId, outcome },
    });
  }

  /** Runs after each welcome, which is how a restart on either side is recovered from. */
  async synced(agentId: string, payload: RestoreSyncPayload): Promise<void> {
    const [active] = await this.pool.execute<RemovalRow[]>(
      `${REMOVAL_QUERY} WHERE op.agent_id = ? AND op.active_marker = 1`,
      [agentId],
    );
    if (payload.capabilities.removeLocal !== true) {
      // This agent cannot remove anything, so whatever is pending will never happen.
      for (const row of active) await this.markFailed(row.id, 'agent_lost_operation');
      return;
    }
    const listed = new Set((payload.removals ?? []).map((entry) => entry.operationId));
    if (listed.size > 0) {
      const ids = [...listed];
      await this.pool.execute(
        `UPDATE local_copy_removals SET accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP(3))
         WHERE agent_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        [agentId, ...ids],
      );
    }
    for (const row of active) {
      if (listed.has(row.id)) continue;
      if (row.accepted_at === null) {
        this.link.send(agentId, { type: 'server.local_copy_remove', payload: commandFor(row) });
      } else {
        // It held the command once, and holds nothing now: never sent again, so never repeated.
        await this.markFailed(row.id, 'agent_lost_operation');
      }
    }
  }

  async result(agentId: string, payload: LocalCopyRemoveResultPayload): Promise<void> {
    const { operationId } = payload;
    const [rows] = await this.pool.execute<RemovalRow[]>(
      `${REMOVAL_QUERY} WHERE op.id = ? AND op.agent_id = ?`,
      [operationId, agentId],
    );
    const row = rows[0];
    if (!row) {
      this.log.warn({ agentId, operationId }, 'A removal result for an unknown operation');
      this.ack(agentId, operationId, 'rejected');
      return;
    }
    if (row.state === 'succeeded') {
      // A later answer only ever says that leftovers are gone.
      if (payload.removed && !payload.cleanupPending && row.cleanup_pending) {
        await this.pool.execute(
          'UPDATE local_copy_removals SET cleanup_pending = FALSE WHERE id = ? AND agent_id = ?',
          [operationId, agentId],
        );
      }
      this.ack(agentId, operationId, 'closed');
      return;
    }
    if (row.state === 'failed') {
      this.ack(agentId, operationId, 'closed');
      return;
    }

    if (!payload.removed) {
      await this.pool.execute(
        `UPDATE local_copy_removals
         SET state = 'failed', error_code = ?, error_message = ?, local_directory = ?,
             accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP(3)), finished_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND agent_id = ? AND state = 'requested'`,
        [
          payload.code ?? 'internal_error',
          payload.message ?? 'The agent did not say why.',
          payload.localDirectory,
          operationId,
          agentId,
        ],
      );
      this.ack(agentId, operationId, 'closed');
      return;
    }

    // One transaction: the operation succeeds, and this agent no longer holds a copy. Only the row that
    // still names the version the administrator saw is removed.
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [locked] = await connection.execute<RowDataPacket[]>(
        'SELECT state FROM local_copy_removals WHERE id = ? AND agent_id = ? FOR UPDATE',
        [operationId, agentId],
      );
      if (locked[0]?.state === 'requested') {
        await connection.execute(
          `DELETE FROM agent_vm_state
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?
             AND local_source_version_id <=> ?`,
          [agentId, row.emulator_type, row.vm_name, row.expected_version_id],
        );
        await connection.execute(
          `UPDATE local_copy_removals
           SET state = 'succeeded', cleanup_pending = ?, local_directory = ?, error_code = NULL,
               error_message = ?, accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP(3)),
               finished_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [payload.cleanupPending, payload.localDirectory, payload.message, operationId],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // No answer: the agent reports again.
      throw error;
    } finally {
      connection.release();
    }
    this.log.info({ agentId, operationId, vmName: row.vm_name }, 'Local copy removed');
    this.ack(agentId, operationId, 'closed');
  }

  /** Revocation ends what was pending, and says nothing about what is on that agent's disk. */
  async agentRevoked(agentId: string): Promise<void> {
    const [active] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1',
      [agentId],
    );
    for (const row of active) await this.markFailed(row.id as string, 'agent_revoked');
  }

  private async markFailed(operationId: string, code: string): Promise<void> {
    await this.pool.execute(
      `UPDATE local_copy_removals
       SET state = 'failed', error_code = ?, error_message = ?, finished_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND active_marker = 1`,
      [code, FAILURE_TEXT[code] ?? code, operationId],
    );
  }
}

class RepeatedRequest extends Error {}
