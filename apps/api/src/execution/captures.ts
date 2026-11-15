import { randomUUID } from 'node:crypto';
import type {
  CaptureOperation,
  CaptureReport,
  CaptureStatus,
  ExecutionSyncPayload,
  ServerMessage,
} from '@emucat/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../db/pool.js';
import { ApiError } from '../errors.js';

interface Link {
  isOnline(id: string): boolean;
  executionCapabilities(id: string): ExecutionSyncPayload['capabilities'] | null;
  /** Whether the agent can capture a running VirtualBox machine (decision 0046). */
  isVirtualBoxManagementCapable(id: string): boolean;
  sendToAgent(id: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

/**
 * What an agent reports about a capture. A VirtualBox report names the machine it captured as well, and has to
 * name the one this capture was asked of.
 */
export type CaptureAgentReport =
  | CaptureReport
  | (Omit<CaptureReport, 'emulatorType'> & { emulatorType: 'virtualbox'; machineUuid: string });

/** The screenshot types, and what an agent must be able to do for each. */
type CaptureKind = 'qemu' | 'virtualbox';

function operation(row: RowDataPacket): CaptureOperation {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    sessionId: row.session_id as string,
    agentId: row.agent_id as string,
    emulatorType: row.emulator_type as CaptureKind,
    vmName: row.vm_name as string,
    mode: row.mode as CaptureOperation['mode'],
    versionId: row.source_version_id as string | null,
    state: row.state as CaptureOperation['state'],
    sha256: row.sha256 as string | null,
    mediaId: row.media_id as string | null,
    uncertain: Boolean(row.uncertain),
    code: row.error_code as string | null,
    message: row.error_message as string | null,
    retryAttempts: Number(row.retry_attempts),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export class CaptureCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly link: Link,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.pool
        .execute(
          "UPDATE qemu_captures SET state = 'failed', uncertain = TRUE, error_code = 'capture_outcome_uncertain', error_message = 'The agent did not confirm capture within 60 seconds. Any output remains on the agent; reconnect or retry recovery.' WHERE state IN ('requested', 'capturing') AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 60 SECOND",
        )
        .catch(() => undefined);
    }, 15_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async session(id: string): Promise<RowDataPacket> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT s.*, a.revoked_at FROM vm_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ?',
      [id],
    );
    if (!rows[0]) throw new ApiError(404, 'session_not_found', 'Session not found');
    return rows[0];
  }

  /** The machine a VirtualBox session runs, when the VM is linked to one on the session's agent. */
  private async machineOf(
    executor: Pick<Pool, 'execute'>,
    session: RowDataPacket,
  ): Promise<string | null> {
    if (session.emulator_type !== 'virtualbox') return null;
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT machine_uuid FROM virtualbox_sources
       WHERE emulator_type = 'virtualbox' AND vm_name = ? AND agent_id = ?`,
      [session.vm_name, session.agent_id],
    );
    return (rows[0]?.machine_uuid as string | undefined) ?? null;
  }

  private reason(session: RowDataPacket, machineUuid: string | null): string | null {
    if (session.emulator_type === 'virtualbox') return this.virtualBoxReason(session, machineUuid);
    if (session.emulator_type !== 'qemu')
      return 'Screenshot capture is available only for QEMU and VirtualBox.';
    if (session.revoked_at !== null) return 'The session agent was revoked.';
    if (session.execution_state !== 'running')
      return 'The QEMU session must be running and not stopping.';
    if (!this.link.isOnline(session.agent_id as string)) return 'The session agent is offline.';
    if (this.link.executionCapabilities(session.agent_id as string)?.qemuScreenshot !== true)
      return 'Update the agent to enable QEMU screenshot capture.';
    if (!session.screenshot_available)
      return 'QMP is unavailable. After an agent restart, start a new VM session to capture screenshots.';
    return null;
  }

  /**
   * A VirtualBox screenshot is `controlvm screenshotpng` of the linked machine (decision 0046). It needs the
   * machine running and an agent that can do it; the agent checks the machine again before it captures.
   */
  private virtualBoxReason(session: RowDataPacket, machineUuid: string | null): string | null {
    if (session.revoked_at !== null) return 'The session agent was revoked.';
    if (session.execution_state !== 'running')
      return 'The VirtualBox machine must be running and not stopping.';
    if (!this.link.isOnline(session.agent_id as string)) return 'The session agent is offline.';
    if (!this.link.isVirtualBoxManagementCapable(session.agent_id as string))
      return 'Update the agent to enable VirtualBox screenshot capture.';
    if (!machineUuid) return 'This VM has no linked VirtualBox machine on the session agent.';
    return null;
  }

  async status(sessionId: string): Promise<CaptureStatus> {
    const session = await this.session(sessionId);
    const machineUuid = await this.machineOf(this.pool, session);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM qemu_captures WHERE session_id = ? ORDER BY active_marker DESC, created_at DESC, id DESC LIMIT 1',
      [sessionId],
    );
    const capture = rows[0] ? operation(rows[0]) : null;
    const busy = capture && ['requested', 'capturing', 'uploading'].includes(capture.state);
    const reason =
      this.reason(session, machineUuid) ??
      (busy ? 'A screenshot capture is already in progress.' : null);
    return { available: reason === null, reason, operation: capture };
  }

  async create(sessionId: string, requestId: string, userId: string): Promise<CaptureOperation> {
    const [existing] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM qemu_captures WHERE request_id = ?',
      [requestId],
    );
    if (existing[0]) {
      if (existing[0].session_id !== sessionId)
        throw new ApiError(409, 'request_conflict', 'Request ID belongs to another session');
      return operation(existing[0]);
    }
    const id = randomUUID();
    try {
      await withTransaction(this.pool, async (connection) => {
        const [sessions] = await connection.execute<RowDataPacket[]>(
          'SELECT s.*, a.revoked_at FROM vm_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ? FOR UPDATE',
          [sessionId],
        );
        const session = sessions[0];
        if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
        const machineUuid = await this.machineOf(connection, session);
        const reason = this.reason(session, machineUuid);
        if (reason) throw new ApiError(409, 'capture_unavailable', reason);
        await connection.execute(
          `INSERT INTO qemu_captures
          (id, request_id, session_id, agent_id, requested_by_user_id, emulator_type, vm_name, machine_uuid,
           mode, source_version_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            requestId,
            sessionId,
            session.agent_id,
            userId,
            session.emulator_type,
            session.vm_name,
            machineUuid,
            session.mode,
            session.source_version_id,
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        'SELECT * FROM qemu_captures WHERE request_id = ?',
        [requestId],
      );
      if (rows[0]?.session_id === sessionId) return operation(rows[0]);
      throw new ApiError(
        409,
        'capture_in_progress',
        'A capture is already active or this request ID is in use',
      );
    }
    const capture = await this.get(sessionId, id);
    this.dispatch(capture, await this.capturedMachine(id));
    return capture;
  }

  async get(sessionId: string, id: string): Promise<CaptureOperation> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM qemu_captures WHERE id = ? AND session_id = ?',
      [id, sessionId],
    );
    if (!rows[0]) throw new ApiError(404, 'capture_not_found', 'Capture not found');
    return operation(rows[0]);
  }

  private dispatch(capture: CaptureOperation, machineUuid: string | null): void {
    if (capture.emulatorType === 'virtualbox') {
      if (!machineUuid) return;
      this.link.sendToAgent(capture.agentId, {
        type: 'server.virtualbox_capture',
        payload: {
          operationId: capture.id,
          sessionId: capture.sessionId,
          vmName: capture.vmName,
          machineUuid,
        },
      });
      return;
    }
    this.link.sendToAgent(capture.agentId, {
      type: 'server.qemu_capture',
      payload: {
        operationId: capture.id,
        sessionId: capture.sessionId,
        emulatorType: 'qemu',
        vmName: capture.vmName,
      },
    });
  }

  private async capturedMachine(id: string): Promise<string | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT machine_uuid FROM qemu_captures WHERE id = ?',
      [id],
    );
    return (rows[0]?.machine_uuid as string | null | undefined) ?? null;
  }

  /**
   * Redelivers the unfinished captures of one kind, once the agent has said it can do them: QEMU ones after its
   * execution sync, VirtualBox ones after its registration sync.
   */
  async synced(agentId: string, kind: CaptureKind = 'qemu'): Promise<void> {
    const capable =
      kind === 'qemu'
        ? this.link.executionCapabilities(agentId)?.qemuScreenshot === true
        : this.link.isVirtualBoxManagementCapable(agentId);
    if (!capable) return;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM qemu_captures WHERE agent_id = ? AND emulator_type = ? AND state <> 'completed'",
      [agentId, kind],
    );
    for (const row of rows) {
      const capture = operation(row);
      // Redelivery asks an existing journal for its state; it never authorizes a second capture.
      this.dispatch(capture, row.machine_uuid as string | null);
      if (capture.retryAttempts > 0)
        this.link.sendToAgent(agentId, {
          type: 'server.qemu_capture_retry',
          payload: { operationId: capture.id, attempt: capture.retryAttempts },
        });
    }
  }

  async report(agentId: string, report: CaptureAgentReport): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM qemu_captures WHERE id = ? AND agent_id = ? AND session_id = ? AND emulator_type = ? AND vm_name = ?',
      [report.operationId, agentId, report.sessionId, report.emulatorType, report.vmName],
    );
    const row = rows[0];
    if (!row || (row.sha256 !== null && report.sha256 !== row.sha256)) return;
    // A report about another machine than the one captured belongs to no capture here.
    if (report.emulatorType === 'virtualbox' && row.machine_uuid !== report.machineUuid) return;
    // Never trust an upload claim. Only a committed media row for this VM proves publication.
    if (report.sha256) {
      const [media] = await this.pool.execute<RowDataPacket[]>(
        'SELECT id FROM vm_media WHERE emulator_type = ? AND vm_name = ? AND original_sha256 = ?',
        [row.emulator_type, row.vm_name, report.sha256],
      );
      if (media[0]) {
        await this.pool.execute(
          "UPDATE qemu_captures SET state = 'completed', sha256 = ?, media_id = ?, uncertain = FALSE, error_code = NULL, error_message = NULL WHERE id = ? AND agent_id = ?",
          [report.sha256, media[0].id, report.operationId, agentId],
        );
        this.link.sendToAgent(agentId, {
          type: 'server.qemu_capture_ack',
          payload: {
            operationId: report.operationId,
            sha256: report.sha256,
            mediaId: media[0].id as string,
          },
        });
        return;
      }
    }
    if (row.state === 'completed') return;
    // A delayed report must not reactivate a failed operation alongside a newer capture. Only an
    // explicit retry can reclaim its active slot; a committed image above can always complete it.
    if (row.state === 'failed' && report.state !== 'failed') return;
    // Capturing is a delivery acknowledgement, never a regression from a finalized image.
    if (row.sha256 !== null && report.state === 'capturing') return;
    await this.pool.execute(
      "UPDATE qemu_captures SET state = ?, sha256 = COALESCE(sha256, ?), uncertain = ?, error_code = ?, error_message = ? WHERE id = ? AND state <> 'completed'",
      [
        report.state,
        report.sha256,
        report.uncertain,
        report.code,
        report.message,
        report.operationId,
      ],
    );
  }

  async retry(sessionId: string, id: string): Promise<CaptureOperation> {
    const capture = await this.get(sessionId, id);
    if (
      capture.state !== 'failed' ||
      capture.retryAttempts >= 3 ||
      !this.link.isOnline(capture.agentId)
    )
      throw new ApiError(
        409,
        'capture_retry_unavailable',
        'Only a failed retained capture can be retried, up to three times, while the agent is online. Start a new capture if no complete file exists.',
      );
    try {
      await this.pool.execute(
        "UPDATE qemu_captures SET state = 'uploading', retry_attempts = retry_attempts + 1, error_code = NULL, error_message = NULL WHERE id = ? AND state = 'failed' AND retry_attempts = ?",
        [id, capture.retryAttempts],
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new ApiError(409, 'capture_in_progress', 'Another capture is active');
      throw error;
    }
    const updated = await this.get(sessionId, id);
    this.link.sendToAgent(capture.agentId, {
      type: 'server.qemu_capture_retry',
      payload: { operationId: id, attempt: updated.retryAttempts },
    });
    return updated;
  }
}
