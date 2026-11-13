import {
  EXECUTION_MODE_UNAVAILABLE_REASONS,
  IMPLEMENTED_EXECUTION_MODES,
  EXECUTION_MODES,
  executionRecovery,
  isSessionActive,
  verifyRecovery,
  vmNameKey,
  type AgentExecutionState,
  type ExecutionAgentOption,
  type ExecutionOptionsResponse,
  type ExecutionSyncPayload,
  type LaunchIneligibleReason,
  type LaunchRequest,
  type RemoteIneligibleReason,
  type RemoteSessionMode,
  type RestoreSyncPayload,
  type ServerMessage,
  type VerifyIneligibleReason,
  type VerifyRequest,
  type VmExecutionStatusPayload,
  type VmIdentity,
  type VmSession,
  type VmSessionState,
  type VmVerification,
  type VmVerifyPayload,
  type VmVerifyResultPayload,
} from '@emucat/contracts';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { lockUsableVersion, NOT_DELETED } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';

/** What the coordinator needs from the hub, which owns the sockets. */
export interface ExecutionLink {
  isOnline(agentId: string): boolean;
  /** What `agent.execution_sync` said on this connection. `null` for an agent that cannot launch. */
  executionCapabilities(agentId: string): ExecutionSyncPayload['capabilities'] | null;
  /** Whether the agent said which working copies it holds, which only agents that keep them do. */
  workspacesSupported(agentId: string): boolean;
  /** What `agent.restore_sync` said on this connection: a remote session begins with a restore. */
  restoreCapabilities(agentId: string): RestoreSyncPayload['capabilities'] | null;
  send(agentId: string, message: Pick<ServerMessage, 'type' | 'payload'>): boolean;
}

export interface ExecutionOptions {
  /** How long a launch or verification may go unanswered before it is given up. */
  answerTimeoutMs: number;
}

const DEFAULT_OPTIONS: ExecutionOptions = { answerTimeoutMs: 120_000 };

interface SessionRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  requested_by_display_name: string | null;
  emulator_type: VmSession['emulatorType'];
  vm_name: string;
  source_version_id: string | null;
  workspace_id: string | null;
  mode: VmSession['mode'];
  execution_state: VmSessionState;
  pid: number | null;
  process_started_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  exit_code: number | string | null;
  stop_requested_at: Date | null;
  force_requested_at: Date | null;
  graceful_stop_available: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

const SESSION_QUERY = `
  SELECT s.id, s.agent_id, a.name AS agent_name, u.display_name AS requested_by_display_name,
         s.emulator_type, s.vm_name, s.source_version_id, s.workspace_id, s.mode,
         s.execution_state, s.pid,
         s.process_started_at, s.started_at, s.ended_at, s.exit_code, s.stop_requested_at,
         s.force_requested_at, s.graceful_stop_available, s.error_code, s.error_message,
         s.created_at, s.updated_at
  FROM vm_sessions AS s
  JOIN agents AS a ON a.id = s.agent_id
  LEFT JOIN users AS u ON u.id = s.user_id`;

interface VerificationRow extends RowDataPacket {
  id: string;
  agent_id: string;
  agent_name: string;
  requested_by_display_name: string | null;
  emulator_type: VmVerification['emulatorType'];
  vm_name: string;
  version_id: string;
  repository_id: string;
  state: VmVerification['state'];
  status: VmVerification['status'];
  files_verified: number | string | null;
  bytes_hashed: number | string | null;
  duration_ms: number | string | null;
  missing_count: number | string | null;
  modified_count: number | string | null;
  unexpected_count: number | string | null;
  paths: unknown;
  manifest_sha256: string | null;
  manifest_source: VmVerification['manifestSource'];
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const VERIFICATION_QUERY = `
  SELECT v.id, v.agent_id, a.name AS agent_name, u.display_name AS requested_by_display_name,
         v.emulator_type, v.vm_name, v.version_id, v.repository_id, v.state, v.status,
         v.files_verified, v.bytes_hashed, v.duration_ms, v.missing_count, v.modified_count,
         v.unexpected_count, v.paths, v.manifest_sha256, v.manifest_source, v.error_code,
         v.error_message, v.created_at, v.completed_at
  FROM vm_verifications AS v
  JOIN agents AS a ON a.id = v.agent_id
  LEFT JOIN users AS u ON u.id = v.requested_by_user_id`;

const toNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

const toDate = (value: string | null): Date | null => (value === null ? null : new Date(value));

/** Codes that describe how a session ended rather than a failure. */
const INFORMATIONAL_CODES = new Set(['forced']);

function toSession(row: SessionRow, online: boolean): VmSession {
  const error =
    row.error_code && !INFORMATIONAL_CODES.has(row.error_code)
      ? { code: row.error_code, message: row.error_message ?? '' }
      : null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentOnline: online,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    mode: row.mode,
    state: row.execution_state,
    versionId: row.source_version_id,
    workspaceId: row.workspace_id,
    pid: row.pid,
    processStartedAt: row.process_started_at?.toISOString() ?? null,
    requestedAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    exitCode: toNumber(row.exit_code),
    stopRequested: row.stop_requested_at !== null,
    forceRequested: row.force_requested_at !== null,
    gracefulStopAvailable: online && row.graceful_stop_available !== 0,
    error,
    recovery: row.error_code ? executionRecovery(row.error_code) : null,
    requestedByDisplayName: row.requested_by_display_name,
    updatedAt: row.updated_at.toISOString(),
  };
}

type PathLists = Pick<VmVerifyResultPayload, 'missing' | 'modified' | 'unexpected'>;

function toVerification(row: VerificationRow): VmVerification {
  const paths = (typeof row.paths === 'string' ? JSON.parse(row.paths) : row.paths) as Record<
    keyof PathLists,
    string[]
  > | null;
  const list = (count: number | string | null, key: keyof PathLists) =>
    count === null ? null : { count: Number(count), paths: paths?.[key] ?? [] };
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    emulatorType: row.emulator_type,
    vmName: row.vm_name,
    versionId: row.version_id,
    state: row.state,
    status: row.status,
    filesVerified: toNumber(row.files_verified),
    bytesHashed: toNumber(row.bytes_hashed),
    durationMs: toNumber(row.duration_ms),
    missing: list(row.missing_count, 'missing'),
    modified: list(row.modified_count, 'modified'),
    unexpected: list(row.unexpected_count, 'unexpected'),
    manifestSha256: row.manifest_sha256,
    manifestSource: row.manifest_source,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    recovery: row.error_code ? verifyRecovery(row.error_code) : null,
    requestedByDisplayName: row.requested_by_display_name,
    requestedAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}

const LAUNCH_TEXT: Record<LaunchIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_launch: 'This agent’s version cannot launch VMs. Update it.',
  emulator_not_launchable: 'This agent cannot launch this emulator. Check its executable setting.',
  vm_not_on_agent: 'This agent holds no copy of this VM. Restore it there first.',
  session_active: 'This VM is already running on this agent.',
  operation_in_progress:
    'A registration, restore or verification of this VM is in progress on this agent.',
};

const VERIFY_TEXT: Record<VerifyIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_verify: 'This agent’s version cannot verify VMs. Update it.',
  no_master: 'This VM has no master to verify against.',
  vm_not_on_agent: 'This agent holds no copy of this VM.',
  session_active: 'The VM is running on this agent. Stop it, then verify.',
  operation_in_progress: 'This agent is busy with another operation.',
};

const AGENT_STATES: readonly AgentExecutionState[] = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'exited',
  'failed',
  'unknown',
];

interface AgentFacts {
  revoked: boolean;
  localPresent: boolean;
  activeSession: boolean;
  busyWithVm: boolean;
  busyAtAll: boolean;
}

/** What a remote session needs on top of a launch: a restore of the VM's repository into a working copy. */
interface RemoteFacts {
  hasVersions: boolean;
  repositoryId: string | null;
  authorized: boolean;
  activeWorkspace: boolean;
}

const REMOTE_TEXT: Record<RemoteIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_launch: 'This agent’s version cannot launch VMs. Update it.',
  emulator_not_launchable: 'This agent cannot launch this emulator. Check its executable setting.',
  mode_not_supported: 'This agent’s version cannot run this mode. Update it.',
  agent_cannot_restore: 'This agent’s version cannot obtain VMs from a repository. Update it.',
  emulator_not_configured: 'This agent has no base path configured for this emulator.',
  repository_not_authorized: 'This agent is not associated with this VM’s repository.',
  repository_not_configured: 'This agent has no local configuration for this VM’s repository.',
  no_versions: 'This VM has no version in a repository yet.',
  session_active: 'This VM is already running on this agent.',
  remote_session_pending:
    'A remote session of this VM is still active on this agent: wait for it to finish, or resolve it first.',
  operation_in_progress: 'This agent is busy with another operation.',
};

/**
 * Sessions and verifications on the server's side. Like the other coordinators it keeps no state of its
 * own: `vm_sessions` and `vm_verifications` are the record, so a restart of the server loses nothing, and
 * every agent report is checked against them. Reports repeat until answered, so every handler is
 * idempotent. Nothing here can name a command, a path or a process: the agent decides all of that.
 */
export class ExecutionCoordinator {
  private readonly options: ExecutionOptions;

  constructor(
    private readonly pool: Pool,
    private readonly link: ExecutionLink,
    private readonly log: FastifyBaseLogger,
    options: Partial<ExecutionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Called when the session of a working copy changes state, so that a remote session can move on
   * (decision 0040). `confirmed` says that an administrator has said the emulator no longer runs. A missed
   * call is harmless: the remote sessions' sweep looks again.
   */
  onWorkspaceSession: ((workspaceId: string, confirmed: boolean) => void) | null = null;

  private notifyWorkspace(workspaceId: string | null, confirmed = false): void {
    if (workspaceId) this.onWorkspaceSession?.(workspaceId, confirmed);
  }

  /** Why an agent cannot start a remote session of this VM in this mode now, or `null` if it can. */
  remoteIneligible(
    agentId: string,
    emulatorType: VmIdentity['emulatorType'],
    mode: RemoteSessionMode,
    facts: AgentFacts,
    remote: RemoteFacts,
  ): { reason: RemoteIneligibleReason; problem: string | null } | null {
    if (facts.revoked) return { reason: 'agent_revoked', problem: null };
    if (!this.link.isOnline(agentId)) return { reason: 'agent_offline', problem: null };
    const capabilities = this.link.executionCapabilities(agentId);
    if (!capabilities) return { reason: 'agent_cannot_launch', problem: null };
    const emulator = capabilities.emulators.find((item) => item.emulatorType === emulatorType);
    if (!emulator?.launchable) {
      return { reason: 'emulator_not_launchable', problem: emulator?.problem ?? null };
    }
    if (!this.canRunRemote(agentId, mode)) return { reason: 'mode_not_supported', problem: null };
    const restore = this.link.restoreCapabilities(agentId);
    if (!restore) return { reason: 'agent_cannot_restore', problem: null };
    if (!restore.emulators.some((item) => item.emulatorType === emulatorType)) {
      return { reason: 'emulator_not_configured', problem: null };
    }
    if (!remote.hasVersions || !remote.repositoryId)
      return { reason: 'no_versions', problem: null };
    if (!remote.authorized) return { reason: 'repository_not_authorized', problem: null };
    if (!restore.repositoryIds.includes(remote.repositoryId)) {
      return { reason: 'repository_not_configured', problem: null };
    }
    if (facts.activeSession) return { reason: 'session_active', problem: null };
    if (remote.activeWorkspace) return { reason: 'remote_session_pending', problem: null };
    if (facts.busyAtAll) return { reason: 'operation_in_progress', problem: null };
    return null;
  }

  /** Refuses a remote session that cannot start now, with the reason. Nothing is ever substituted. */
  async requireRemote(agentId: string, vm: VmIdentity, mode: RemoteSessionMode): Promise<void> {
    const [agents] = await this.pool.execute<RowDataPacket[]>(
      'SELECT revoked_at, paired_at FROM agents WHERE id = ?',
      [agentId],
    );
    if (!agents[0] || !agents[0].paired_at) {
      throw new ApiError(404, 'agent_not_found', 'Agent not found');
    }
    const facts: AgentFacts = {
      revoked: agents[0].revoked_at !== null,
      ...(await this.facts(this.pool, agentId, vm)),
    };
    const refused = this.remoteIneligible(
      agentId,
      vm.emulatorType,
      mode,
      facts,
      await this.remoteFacts(agentId, vm),
    );
    if (refused) {
      const code =
        refused.reason === 'mode_not_supported' ? 'execution_mode_unavailable' : refused.reason;
      const text =
        refused.reason === 'mode_not_supported'
          ? EXECUTION_MODE_UNAVAILABLE_REASONS[mode]
          : (refused.problem ?? REMOTE_TEXT[refused.reason]);
      throw new ApiError(409, code, `${text} Nothing was prepared.`);
    }
  }

  private async remoteFacts(agentId: string, vm: VmIdentity): Promise<RemoteFacts> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT
         (SELECT version.repository_id FROM vm_versions AS version
           WHERE version.emulator_type = ? AND version.vm_name = ? AND version.kind = 'master'
           LIMIT 1) AS repository_id,
         (SELECT COUNT(*) FROM vm_versions AS version
           WHERE version.emulator_type = ? AND version.vm_name = ? AND ${NOT_DELETED('version')})
           AS versions,
         (SELECT COUNT(*) FROM vm_versions AS version
           JOIN agent_repositories AS ar
             ON ar.repository_id = version.repository_id AND ar.agent_id = ?
           WHERE version.emulator_type = ? AND version.vm_name = ? AND version.kind = 'master')
           AS authorized,
         (SELECT COUNT(*) FROM vm_workspaces
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1)
           AS workspaces`,
      [
        vm.emulatorType,
        vm.vmName,
        vm.emulatorType,
        vm.vmName,
        agentId,
        vm.emulatorType,
        vm.vmName,
        agentId,
        vm.emulatorType,
        vm.vmName,
      ],
    );
    const row = rows[0] as RowDataPacket;
    return {
      hasVersions: Number(row.versions) > 0,
      repositoryId: (row.repository_id as string | null) ?? null,
      authorized: Number(row.authorized) > 0,
      activeWorkspace: Number(row.workspaces) > 0,
    };
  }

  private launchIneligible(
    agentId: string,
    emulatorType: VmIdentity['emulatorType'],
    facts: AgentFacts,
  ): { reason: LaunchIneligibleReason; problem: string | null } | null {
    if (facts.revoked) return { reason: 'agent_revoked', problem: null };
    if (!this.link.isOnline(agentId)) return { reason: 'agent_offline', problem: null };
    const capabilities = this.link.executionCapabilities(agentId);
    if (!capabilities) return { reason: 'agent_cannot_launch', problem: null };
    const emulator = capabilities.emulators.find((item) => item.emulatorType === emulatorType);
    if (!emulator?.launchable) {
      return { reason: 'emulator_not_launchable', problem: emulator?.problem ?? null };
    }
    if (!facts.localPresent) return { reason: 'vm_not_on_agent', problem: null };
    if (facts.activeSession) return { reason: 'session_active', problem: null };
    if (facts.busyWithVm) return { reason: 'operation_in_progress', problem: null };
    return null;
  }

  private verifyIneligible(
    agentId: string,
    hasMaster: boolean,
    facts: AgentFacts,
  ): VerifyIneligibleReason | null {
    if (facts.revoked) return 'agent_revoked';
    if (!this.link.isOnline(agentId)) return 'agent_offline';
    if (!this.link.executionCapabilities(agentId)) return 'agent_cannot_verify';
    if (!hasMaster) return 'no_master';
    if (!facts.localPresent) return 'vm_not_on_agent';
    if (facts.activeSession) return 'session_active';
    if (facts.busyAtAll) return 'operation_in_progress';
    return null;
  }

  /** What each agent's disk work and sessions say about one VM. Read inside or outside a transaction. */
  private async facts(
    executor: Pool | PoolConnection,
    agentId: string,
    vm: VmIdentity,
  ): Promise<Omit<AgentFacts, 'revoked'>> {
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT
         (SELECT execution_state FROM agent_vm_state
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?) AS local_state,
         (SELECT COUNT(*) FROM vm_sessions
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1) AS sessions,
         (SELECT COUNT(*) FROM registration_operations
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM restore_operations
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM vm_verifications
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM local_copy_removals
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1) AS vm_work,
         (SELECT COUNT(*) FROM registration_operations WHERE agent_id = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM restore_operations WHERE agent_id = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM vm_verifications WHERE agent_id = ? AND active_marker = 1) +
         (SELECT COUNT(*) FROM local_copy_removals WHERE agent_id = ? AND active_marker = 1) AS work`,
      [
        ...[agentId, vm.emulatorType, vm.vmName],
        ...[agentId, vm.emulatorType, vm.vmName],
        ...[agentId, vm.emulatorType, vm.vmName],
        ...[agentId, vm.emulatorType, vm.vmName],
        ...[agentId, vm.emulatorType, vm.vmName],
        ...[agentId, vm.emulatorType, vm.vmName],
        agentId,
        agentId,
        agentId,
        agentId,
      ],
    );
    const row = rows[0] as RowDataPacket;
    const localState = (row.local_state as string | null) ?? null;
    return {
      localPresent: localState !== null && localState !== 'absent',
      activeSession: Number(row.sessions) > 0,
      busyWithVm: Number(row.vm_work) > 0,
      busyAtAll: Number(row.work) > 0,
    };
  }

  // What an administrator sees and does.

  async executionOptions(vm: VmIdentity): Promise<ExecutionOptionsResponse> {
    const [masters] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM vm_versions WHERE emulator_type = ? AND vm_name = ? AND kind = 'master'`,
      [vm.emulatorType, vm.vmName],
    );
    const hasMaster = masters.length > 0;
    const [agents] = await this.pool.execute<RowDataPacket[]>(
      `SELECT a.id, a.name, s.local_source_version_id, s.execution_state, s.content_status,
              s.last_verified_at
       FROM agents AS a
       LEFT JOIN agent_vm_state AS s ON s.agent_id = a.id AND s.emulator_type = ? AND s.vm_name = ?
       WHERE a.revoked_at IS NULL AND a.paired_at IS NOT NULL
       ORDER BY a.name, a.id`,
      [vm.emulatorType, vm.vmName],
    );
    const options: ExecutionAgentOption[] = [];
    for (const agent of agents) {
      const agentId = agent.id as string;
      const facts: AgentFacts = { revoked: false, ...(await this.facts(this.pool, agentId, vm)) };
      const launch = this.launchIneligible(agentId, vm.emulatorType, facts);
      const verify = this.verifyIneligible(agentId, hasMaster, facts);
      const state = (agent.execution_state as string | null) ?? null;
      const [active] = await this.pool.execute<SessionRow[]>(
        `${SESSION_QUERY} WHERE s.agent_id = ? AND s.emulator_type = ? AND s.vm_name = ?
         ORDER BY s.active_marker IS NULL, s.created_at DESC LIMIT 1`,
        [agentId, vm.emulatorType, vm.vmName],
      );
      const [verifications] = await this.pool.execute<VerificationRow[]>(
        `${VERIFICATION_QUERY} WHERE v.agent_id = ? AND v.emulator_type = ? AND v.vm_name = ?
         ORDER BY v.created_at DESC LIMIT 1`,
        [agentId, vm.emulatorType, vm.vmName],
      );
      const latest = active[0] ? toSession(active[0], this.link.isOnline(agentId)) : null;
      const remoteFacts = await this.remoteFacts(agentId, vm);
      const remote = (mode: RemoteSessionMode) => {
        const refused = this.remoteIneligible(agentId, vm.emulatorType, mode, facts, remoteFacts);
        return {
          eligible: refused === null,
          reason: refused?.reason ?? null,
          problem: refused?.problem ?? null,
        };
      };
      const [workspaces] = await this.pool.execute<RowDataPacket[]>(
        `SELECT id FROM vm_workspaces
         WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND active_marker = 1`,
        [agentId, vm.emulatorType, vm.vmName],
      );
      options.push({
        agentId,
        agentName: agent.name as string,
        online: this.link.isOnline(agentId),
        launch: {
          eligible: launch === null,
          reason: launch?.reason ?? null,
          problem: launch?.problem ?? null,
        },
        verify: { eligible: verify === null, reason: verify },
        remote: {
          remote_volatile: remote('remote_volatile'),
          remote_snapshot: remote('remote_snapshot'),
        },
        activeWorkspaceId: (workspaces[0]?.id as string | undefined) ?? null,
        local: {
          present: facts.localPresent,
          contentStatus:
            state === null || state === 'absent'
              ? null
              : (agent.content_status as 'unverified' | 'verified' | 'modified'),
          sourceVersionId: (agent.local_source_version_id as string | null) ?? null,
          lastVerifiedAt: (agent.last_verified_at as Date | null)?.toISOString() ?? null,
        },
        activeSession: latest && isSessionActive(latest.state) ? latest : null,
        lastSession: latest && !isSessionActive(latest.state) ? latest : null,
        lastVerification: verifications[0] ? toVerification(verifications[0]) : null,
      });
    }
    return {
      modes: EXECUTION_MODES.map((mode) => ({
        mode,
        available: IMPLEMENTED_EXECUTION_MODES.includes(mode),
        reason:
          IMPLEMENTED_EXECUTION_MODES.includes(mode) || mode === 'local'
            ? null
            : EXECUTION_MODE_UNAVAILABLE_REASONS[mode],
      })),
      agents: options,
    };
  }

  /**
   * Starts one session for a request. A repeated request, from a double click or a retry, finds the
   * session it already started. A mode this version cannot run is refused, never replaced.
   */
  async launch(input: LaunchRequest, userId: string | null): Promise<VmSession> {
    const { agentId, emulatorType, vmName, mode, requestId } = input;
    const [repeated] = await this.pool.execute<SessionRow[]>(
      `${SESSION_QUERY} WHERE s.request_id = ?`,
      [requestId],
    );
    if (repeated[0]) return this.sameRequest(repeated[0], input);

    if (!IMPLEMENTED_EXECUTION_MODES.includes(mode)) {
      throw new ApiError(
        409,
        'execution_mode_unavailable',
        EXECUTION_MODE_UNAVAILABLE_REASONS[mode as Exclude<typeof mode, 'local'>],
      );
    }

    const workspaceId = input.workspaceId ?? null;
    if (mode !== 'local' && !this.canRunRemote(agentId, mode)) {
      throw new ApiError(
        409,
        'execution_mode_unavailable',
        `${EXECUTION_MODE_UNAVAILABLE_REASONS[mode]} Nothing was launched.`,
      );
    }

    const sessionId = randomUUID();
    let canonicalName: string;
    let versionId: string | null;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Registration and restore take this row's lock too, so none of them can start alongside.
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? FOR UPDATE',
        [agentId],
      );
      const agent = agents[0];
      if (!agent || !agent.paired_at) throw new ApiError(404, 'agent_not_found', 'Agent not found');
      const [vms] = await connection.execute<RowDataPacket[]>(
        'SELECT vm_name FROM virtual_machines WHERE emulator_type = ? AND vm_name = ?',
        [emulatorType, vmName],
      );
      if (!vms[0]) throw new ApiError(404, 'vm_not_found', 'Virtual machine not found');
      canonicalName = vms[0].vm_name as string;
      const vm = { emulatorType, vmName: canonicalName };
      const facts = await this.facts(connection, agentId, vm);
      let workspace: RowDataPacket | undefined;
      if (workspaceId) {
        // A working copy has its own directory: what matters is that it is ready, not the local copy.
        const [workspaces] = await connection.execute<RowDataPacket[]>(
          `SELECT state, purpose, base_version_id, source_version_id FROM vm_workspaces
           WHERE id = ? AND agent_id = ? AND emulator_type = ? AND vm_name = ? FOR UPDATE`,
          [workspaceId, agentId, emulatorType, canonicalName],
        );
        workspace = workspaces[0];
        if (!workspace) throw new ApiError(404, 'workspace_not_found', 'Working copy not found');
        // A remote session runs only in the mode it was prepared for; a Milestone 7 working copy only
        // as Remote Snapshot, as it always did. The agent checks this again.
        const purpose = workspace.purpose as string;
        if ((purpose === 'manual' ? 'remote_snapshot' : purpose) !== mode) {
          throw new ApiError(
            409,
            'workspace_purpose_mismatch',
            'This working copy was prepared for another mode. Nothing was launched.',
          );
        }
        if (workspace.state !== 'ready') {
          throw new ApiError(
            409,
            'workspace_unavailable',
            'This working copy is not ready. Nothing was launched.',
          );
        }
      }
      const refused = this.launchIneligible(agentId, emulatorType, {
        revoked: agent.revoked_at !== null,
        ...facts,
        localPresent: workspace ? true : facts.localPresent,
      });
      if (refused) {
        throw new ApiError(409, refused.reason, refused.problem ?? LAUNCH_TEXT[refused.reason]);
      }
      if (workspace) {
        // A remote session runs exactly the version that was chosen for it.
        versionId = (
          workspace.purpose === 'manual' ? workspace.source_version_id : workspace.base_version_id
        ) as string;
      } else {
        const [states] = await connection.execute<RowDataPacket[]>(
          `SELECT local_source_version_id FROM agent_vm_state
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          [agentId, emulatorType, canonicalName],
        );
        versionId = (states[0]?.local_source_version_id as string | null | undefined) ?? null;
      }
      try {
        await connection.execute(
          `INSERT INTO vm_sessions
             (id, agent_id, user_id, request_id, emulator_type, vm_name, source_version_id,
              workspace_id, mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            agentId,
            userId,
            requestId,
            emulatorType,
            canonicalName,
            versionId,
            workspaceId,
            mode,
          ],
        );
        if (workspaceId) {
          // Whatever happens next, the working copy may now differ from its source. A remote session is
          // running from this moment, and its session is the one that says when it ends.
          await connection.execute(
            `UPDATE vm_workspaces
             SET may_have_changes = TRUE, launch_on_ready = FALSE,
                 state = IF(purpose = 'manual', state, 'running'),
                 session_id = IF(purpose = 'manual', session_id, ?)
             WHERE id = ?`,
            [sessionId, workspaceId],
          );
        }
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ApiError(409, 'session_active', LAUNCH_TEXT.session_active);
        }
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      // Two identical requests at once: the loser finds the winner's session.
      if (error instanceof ApiError && error.code === 'session_active') {
        const [winner] = await this.pool.execute<SessionRow[]>(
          `${SESSION_QUERY} WHERE s.request_id = ?`,
          [requestId],
        );
        if (winner[0]) return this.sameRequest(winner[0], input);
      }
      throw error;
    } finally {
      connection.release();
    }

    this.link.send(agentId, {
      type: 'server.vm_launch',
      payload: {
        sessionId,
        emulatorType,
        vmName: canonicalName,
        mode,
        versionId,
        ...(workspaceId ? { workspaceId } : {}),
      },
    });
    return this.requireSession(sessionId);
  }

  /** A remote mode needs the agent to say it runs the mode, and that it keeps working copies. */
  canRunRemote(agentId: string, mode: RemoteSessionMode): boolean {
    return (
      this.link.executionCapabilities(agentId)?.modes.includes(mode) === true &&
      this.link.workspacesSupported(agentId)
    );
  }

  private sameRequest(row: SessionRow, input: LaunchRequest): VmSession {
    if (
      row.agent_id !== input.agentId ||
      row.emulator_type !== input.emulatorType ||
      vmNameKey(row.vm_name) !== vmNameKey(input.vmName) ||
      row.mode !== input.mode ||
      row.workspace_id !== (input.workspaceId ?? null)
    ) {
      throw new ApiError(409, 'request_id_reused', 'This request ID belongs to another launch.');
    }
    return toSession(row, this.link.isOnline(row.agent_id));
  }

  /**
   * A graceful stop asks the emulator to close; a forced one ends it, and needs the VM's name typed
   * again. Neither is queued for an agent that is away: a stop arriving later could surprise someone.
   */
  async stop(
    sessionId: string,
    request: { force: boolean; confirmVmName?: string | undefined },
  ): Promise<VmSession> {
    const session = await this.requireSession(sessionId);
    if (!isSessionActive(session.state)) {
      throw new ApiError(409, 'session_ended', 'This session has already ended.');
    }
    if (session.state === 'requested') {
      throw new ApiError(409, 'session_not_started', 'The emulator has not started yet.');
    }
    if (session.state === 'unknown') {
      throw new ApiError(
        409,
        'session_unknown',
        'The agent cannot tell whether this emulator runs, so it cannot stop it. Check that computer, then dismiss the session.',
      );
    }
    if (request.force && vmNameKey(request.confirmVmName ?? '') !== vmNameKey(session.vmName)) {
      throw new ApiError(
        400,
        'confirmation_mismatch',
        'Type the VM’s name to confirm a forced stop.',
      );
    }
    if (!this.link.isOnline(session.agentId)) {
      throw new ApiError(409, 'agent_offline', 'This agent is offline.');
    }
    await this.pool.execute(
      `UPDATE vm_sessions
       SET stop_requested_at = COALESCE(stop_requested_at, UTC_TIMESTAMP(3))${
         request.force
           ? ', force_requested_at = COALESCE(force_requested_at, UTC_TIMESTAMP(3))'
           : ''
       }
       WHERE id = ? AND active_marker = 1`,
      [sessionId],
    );
    this.link.send(session.agentId, {
      type: 'server.vm_stop',
      payload: {
        sessionId,
        emulatorType: session.emulatorType,
        vmName: session.vmName,
        force: request.force,
      },
    });
    return this.requireSession(sessionId);
  }

  /**
   * An administrator says that a session the agent cannot account for is over. Only `unknown` and
   * never-started sessions can be dismissed, and only with the VM's name typed again, since this is
   * what lets destructive work on the VM go ahead.
   */
  async dismiss(sessionId: string, confirmVmName: string): Promise<VmSession> {
    const session = await this.requireSession(sessionId);
    if (session.state !== 'unknown' && session.state !== 'requested') {
      throw new ApiError(
        409,
        'session_not_dismissable',
        'Only a session whose state is unknown, or that never started, can be dismissed.',
      );
    }
    if (vmNameKey(confirmVmName) !== vmNameKey(session.vmName)) {
      throw new ApiError(400, 'confirmation_mismatch', 'Type the VM’s name to confirm.');
    }
    await this.pool.execute(
      `UPDATE vm_sessions
       SET execution_state = 'interrupted', ended_at = UTC_TIMESTAMP(3),
           error_code = COALESCE(error_code, 'agent_lost_session'),
           error_message = 'Dismissed by an administrator.'
       WHERE id = ? AND execution_state IN ('unknown', 'requested')`,
      [sessionId],
    );
    this.link.send(session.agentId, { type: 'server.vm_execution_ack', payload: { sessionId } });
    // Typing the name here is the confirmation a held remote session would otherwise ask for.
    this.notifyWorkspace(session.workspaceId, true);
    return this.requireSession(sessionId);
  }

  async getSession(sessionId: string): Promise<VmSession | null> {
    const [rows] = await this.pool.execute<SessionRow[]>(`${SESSION_QUERY} WHERE s.id = ?`, [
      sessionId,
    ]);
    return rows[0] ? toSession(rows[0], this.link.isOnline(rows[0].agent_id)) : null;
  }

  private async requireSession(sessionId: string): Promise<VmSession> {
    const session = await this.getSession(sessionId);
    if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
    return session;
  }

  async listSessions(filter: {
    agentId?: string | undefined;
    emulatorType?: string | undefined;
    vmName?: string | undefined;
    limit?: number | undefined;
  }): Promise<VmSession[]> {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.agentId) {
      conditions.push('s.agent_id = ?');
      values.push(filter.agentId);
    }
    if (filter.emulatorType) {
      conditions.push('s.emulator_type = ?');
      values.push(filter.emulatorType);
    }
    if (filter.vmName) {
      conditions.push('s.vm_name = ?');
      values.push(filter.vmName);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    const [rows] = await this.pool.execute<SessionRow[]>(
      `${SESSION_QUERY} ${where} ORDER BY s.created_at DESC LIMIT ${limit}`,
      values,
    );
    return rows.map((row) => toSession(row, this.link.isOnline(row.agent_id)));
  }

  async verify(input: VerifyRequest, userId: string): Promise<VmVerification> {
    const { agentId, emulatorType, vmName } = input;
    const verificationId = randomUUID();
    let payload: VmVerifyPayload;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [agents] = await connection.execute<RowDataPacket[]>(
        'SELECT revoked_at, paired_at FROM agents WHERE id = ? FOR UPDATE',
        [agentId],
      );
      const agent = agents[0];
      if (!agent || !agent.paired_at) throw new ApiError(404, 'agent_not_found', 'Agent not found');
      // Against the version the copy came from, when that is recorded, so that a restored snapshot
      // verifies as itself; otherwise against the master. A verified result re-establishes lineage.
      const [versions] = await connection.execute<RowDataPacket[]>(
        `SELECT version.id, version.vm_name, version.repository_id, version.archive_key,
                version.archive_sha256, version.archive_size_bytes, reg.manifest_sha256
         FROM vm_versions AS version
         LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
         LEFT JOIN agent_vm_state AS s
           ON s.agent_id = ? AND s.emulator_type = version.emulator_type
          AND s.vm_name = version.vm_name AND s.local_source_version_id = version.id
         WHERE version.emulator_type = ? AND version.vm_name = ?
           AND (version.kind = 'master' OR s.agent_id IS NOT NULL) AND ${NOT_DELETED('version')}
         ORDER BY s.agent_id IS NULL, version.created_at
         LIMIT 1`,
        [agentId, emulatorType, vmName],
      );
      const version = versions[0];
      // Compared against it, so it must not be deleted meanwhile (decision 0041).
      if (version) await lockUsableVersion(connection, version.id as string);
      const canonicalName = (version?.vm_name as string | undefined) ?? vmName;
      const facts = await this.facts(connection, agentId, { emulatorType, vmName: canonicalName });
      const reason = this.verifyIneligible(agentId, version !== undefined, {
        revoked: agent.revoked_at !== null,
        ...facts,
      });
      if (reason) throw new ApiError(409, reason, VERIFY_TEXT[reason]);
      const master = version as RowDataPacket;
      payload = {
        operationId: verificationId,
        emulatorType,
        vmName: canonicalName,
        versionId: master.id as string,
        repositoryId: master.repository_id as string,
        archiveKey: master.archive_key as string,
        archiveSizeBytes: Number(master.archive_size_bytes),
        archiveSha256: master.archive_sha256 as string,
        manifestSha256: (master.manifest_sha256 as string | null) ?? null,
      };
      try {
        await connection.execute(
          `INSERT INTO vm_verifications
             (id, agent_id, requested_by_user_id, emulator_type, vm_name, version_id, repository_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            verificationId,
            agentId,
            userId,
            emulatorType,
            canonicalName,
            payload.versionId,
            payload.repositoryId,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ApiError(409, 'operation_in_progress', VERIFY_TEXT.operation_in_progress);
        }
        throw error;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    this.link.send(agentId, { type: 'server.vm_verify', payload });
    return this.requireVerification(verificationId);
  }

  async getVerification(verificationId: string): Promise<VmVerification | null> {
    const [rows] = await this.pool.execute<VerificationRow[]>(
      `${VERIFICATION_QUERY} WHERE v.id = ?`,
      [verificationId],
    );
    return rows[0] ? toVerification(rows[0]) : null;
  }

  private async requireVerification(verificationId: string): Promise<VmVerification> {
    const verification = await this.getVerification(verificationId);
    if (!verification) throw new ApiError(404, 'verification_not_found', 'Verification not found');
    return verification;
  }

  // What an agent reports. Its identity comes from its connection, and nowhere else.

  /** Runs after each welcome: recovers from a restart of either side, and from lost messages. */
  async synced(agentId: string, payload: ExecutionSyncPayload): Promise<void> {
    for (const status of payload.sessions) {
      await this.status(agentId, status);
    }
    const listed = new Set(payload.sessions.map((session) => session.sessionId));
    const [active] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id, emulator_type, vm_name, source_version_id, workspace_id, mode, execution_state,
              created_at
       FROM vm_sessions WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
    const stale = Date.now() - this.options.answerTimeoutMs;
    for (const row of active) {
      const sessionId = row.id as string;
      if (listed.has(sessionId)) continue;
      if (row.execution_state === 'requested' && (row.created_at as Date).getTime() > stale) {
        // Never delivered. The agent answers a repeated launch with the session's state.
        this.link.send(agentId, {
          type: 'server.vm_launch',
          payload: {
            sessionId,
            emulatorType: row.emulator_type as VmIdentity['emulatorType'],
            vmName: row.vm_name as string,
            mode: row.mode as LaunchRequest['mode'],
            versionId: (row.source_version_id as string | null) ?? null,
            ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}),
          },
        });
      } else if (row.execution_state === 'requested') {
        await this.endWithoutAgent(sessionId, 'failed', 'launch_not_acknowledged');
      } else {
        await this.endWithoutAgent(sessionId, 'interrupted', 'agent_lost_session');
      }
    }

    const verifying = new Set(payload.verifications);
    const [pending] = await this.pool.execute<RowDataPacket[]>(
      `SELECT v.id, v.emulator_type, v.vm_name, v.version_id, v.repository_id, v.created_at,
              version.archive_key, version.archive_sha256, version.archive_size_bytes,
              reg.manifest_sha256
       FROM vm_verifications AS v
       JOIN vm_versions AS version ON version.id = v.version_id
       LEFT JOIN registration_operations AS reg ON reg.version_id = v.version_id
       WHERE v.agent_id = ? AND v.active_marker = 1`,
      [agentId],
    );
    for (const row of pending) {
      const operationId = row.id as string;
      if (verifying.has(operationId)) continue;
      if ((row.created_at as Date).getTime() > stale) {
        this.link.send(agentId, {
          type: 'server.vm_verify',
          payload: {
            operationId,
            emulatorType: row.emulator_type as VmIdentity['emulatorType'],
            vmName: row.vm_name as string,
            versionId: row.version_id as string,
            repositoryId: row.repository_id as string,
            archiveKey: row.archive_key as string,
            archiveSizeBytes: Number(row.archive_size_bytes),
            archiveSha256: row.archive_sha256 as string,
            manifestSha256: (row.manifest_sha256 as string | null) ?? null,
          },
        });
      } else {
        await this.pool.execute(
          `UPDATE vm_verifications
           SET state = 'expired', error_code = 'verify_not_acknowledged',
               error_message = 'The agent did not answer.', completed_at = UTC_TIMESTAMP(3)
           WHERE id = ? AND active_marker = 1`,
          [operationId],
        );
      }
    }
  }

  private async endWithoutAgent(
    sessionId: string,
    state: 'failed' | 'interrupted',
    code: string,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_sessions
       SET execution_state = ?, ended_at = UTC_TIMESTAMP(3), error_code = ?, error_message = ?
       WHERE id = ? AND active_marker = 1`,
      [state, code, executionRecovery(code) ?? code, sessionId],
    );
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT workspace_id FROM vm_sessions WHERE id = ?',
      [sessionId],
    );
    this.notifyWorkspace((rows[0]?.workspace_id as string | null | undefined) ?? null);
  }

  /**
   * The agent's word on one session. An end is recorded and answered, which lets the agent forget it.
   * A status for a session that ended here while the agent was away reopens it: the agent is the one
   * that can see the process, and a VM that runs must be protected as running.
   */
  async status(agentId: string, payload: VmExecutionStatusPayload): Promise<void> {
    const { sessionId } = payload;
    const [rows] = await this.pool.execute<SessionRow[]>(
      `${SESSION_QUERY} WHERE s.id = ? AND s.agent_id = ?`,
      [sessionId, agentId],
    );
    const row = rows[0];
    const terminal = !AGENT_STATES.includes(payload.state) || !isSessionActive(payload.state);
    if (!row) {
      this.log.warn(
        { agentId, sessionId },
        'A session status for a session this server does not know',
      );
      if (terminal) this.ack(agentId, sessionId);
      return;
    }
    if (
      row.emulator_type !== payload.emulatorType ||
      vmNameKey(row.vm_name) !== vmNameKey(payload.vmName)
    ) {
      this.log.error({ agentId, sessionId }, 'A session status that names another VM');
      return;
    }
    if (!isSessionActive(row.execution_state) && terminal) {
      this.ack(agentId, sessionId);
      return;
    }

    const endedAt = terminal ? (toDate(payload.endedAt) ?? new Date()) : null;
    try {
      await this.pool.execute(
        `UPDATE vm_sessions
         SET execution_state = ?, pid = ?, process_started_at = ?,
             started_at = COALESCE(?, started_at), ended_at = ?, exit_code = ?,
             stop_requested_at = IF(? AND stop_requested_at IS NULL, UTC_TIMESTAMP(3), stop_requested_at),
             graceful_stop_available = ?, error_code = ?, error_message = ?
         WHERE id = ? AND agent_id = ?`,
        [
          payload.state,
          payload.pid,
          toDate(payload.processStartedAt),
          toDate(payload.startedAt),
          endedAt,
          payload.exitCode,
          payload.stopRequested,
          payload.gracefulStopAvailable,
          payload.code,
          payload.message,
          sessionId,
          agentId,
        ],
      );
    } catch (error) {
      if (isDuplicateEntry(error)) {
        // Reopening would make two active sessions of one VM. The agent's report repeats.
        this.log.error({ agentId, sessionId }, 'Cannot reopen a session: another one is active');
        return;
      }
      throw error;
    }
    // An end lets a remote session move on, and a reopened session brings a held one back to running.
    this.notifyWorkspace(row.workspace_id);
    if (terminal) this.ack(agentId, sessionId);
  }

  private ack(agentId: string, sessionId: string): void {
    this.link.send(agentId, { type: 'server.vm_execution_ack', payload: { sessionId } });
  }

  /** The agent's verdict. It changes what is recorded about the local copy, and nothing else. */
  async verifyResult(agentId: string, payload: VmVerifyResultPayload): Promise<void> {
    const { operationId } = payload;
    const [rows] = await this.pool.execute<VerificationRow[]>(
      `${VERIFICATION_QUERY} WHERE v.id = ? AND v.agent_id = ?`,
      [operationId, agentId],
    );
    const row = rows[0];
    const ack = () =>
      this.link.send(agentId, { type: 'server.vm_verify_ack', payload: { operationId } });
    if (!row) {
      this.log.warn({ agentId, operationId }, 'A verification result for an unknown operation');
      ack();
      return;
    }
    if (row.state !== 'requested') {
      ack();
      return;
    }
    const nil = payload.versionId === '00000000-0000-0000-0000-000000000000';
    if (!nil && payload.versionId !== row.version_id) {
      this.log.error({ agentId, operationId }, 'A verification result for another version');
      return;
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE vm_verifications
         SET state = 'completed', status = ?, files_verified = ?, bytes_hashed = ?, duration_ms = ?,
             missing_count = ?, modified_count = ?, unexpected_count = ?, paths = ?,
             manifest_sha256 = ?, manifest_source = ?, error_code = ?, error_message = ?,
             completed_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND state = 'requested'`,
        [
          payload.status,
          payload.filesVerified,
          payload.bytesHashed,
          payload.durationMs,
          payload.missing.count,
          payload.modified.count,
          payload.unexpected.count,
          JSON.stringify({
            missing: payload.missing.paths,
            modified: payload.modified.paths,
            unexpected: payload.unexpected.paths,
          }),
          payload.manifestSha256,
          payload.manifestSource,
          payload.code,
          payload.message,
          operationId,
        ],
      );
      const identity = [agentId, row.emulator_type, row.vm_name];
      if (payload.status === 'verified' && payload.manifestSha256) {
        // The copy is this master, file for file, whatever was recorded about it before.
        await connection.execute(
          `UPDATE agent_vm_state
           SET content_status = 'verified', last_verified_at = UTC_TIMESTAMP(3),
               last_verified_sha256 = ?, local_source_version_id = ?,
               execution_state = IF(execution_state IN ('absent', 'unknown'), 'idle', execution_state)
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          [payload.manifestSha256, row.version_id, ...identity],
        );
      } else if (payload.status === 'missing' && payload.code === 'vm_not_found') {
        await connection.execute(
          `UPDATE agent_vm_state
           SET execution_state = 'absent', content_status = 'unverified', last_verified_at = NULL,
               last_verified_sha256 = NULL
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ?`,
          identity,
        );
      } else if (payload.status === 'modified' || payload.status === 'missing') {
        await connection.execute(
          `UPDATE agent_vm_state SET content_status = 'modified'
           WHERE agent_id = ? AND emulator_type = ? AND vm_name = ? AND execution_state <> 'absent'`,
          identity,
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    ack();
  }

  /** Revocation ends what the server is waiting for. It says nothing about what still runs there. */
  async agentRevoked(agentId: string): Promise<void> {
    await this.pool.execute(
      `UPDATE vm_sessions
       SET execution_state = 'interrupted', ended_at = UTC_TIMESTAMP(3), error_code = 'agent_revoked',
           error_message = 'The agent was revoked. Whatever it started may still be running.'
       WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
    await this.pool.execute(
      `UPDATE vm_verifications
       SET state = 'expired', error_code = 'agent_revoked', error_message = 'The agent was revoked.',
           completed_at = UTC_TIMESTAMP(3)
       WHERE agent_id = ? AND active_marker = 1`,
      [agentId],
    );
  }
}
