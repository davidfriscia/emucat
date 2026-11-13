import { randomUUID } from 'node:crypto';
import {
  agentMessageSchema,
  discoveryRequestPayloadSchema,
  envelopeSchema,
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  type AgentHelloPayload,
  type AgentMessage,
  type AdminMediaSyncResponse,
  type Envelope,
  type MediaSyncStatusPayload,
  type Platform,
  type ServerMessage,
  type VmIdentity,
  vmNameKey,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  RegistrationCleanupPayload,
  RegistrationErrorPayload,
  RegistrationProgressPayload,
  RegistrationResultPayload,
  RegistrationSyncPayload,
  RepositoryHealthResultPayload,
  RestoreErrorPayload,
  RestoreProgressPayload,
  RestoreResultPayload,
  RestoreSyncPayload,
  ExecutionSyncPayload,
  VmExecutionStatusPayload,
  VmVerifyResultPayload,
  WorkspaceDiscardResultPayload,
  LocalCopyRemoveResultPayload,
  ArchiveDeleteResultPayload,
} from '@emucat/contracts';
import { DiscoveryCoordinator, type DiscoveryRecord } from './discovery.js';

/**
 * Where presence is recorded. `connected` and `seen` return false for an agent that has been revoked,
 * so a connection cannot outlive its credential even if the revocation happened somewhere else.
 */
export interface AgentPresence {
  connected(agentId: string, hello: AgentHelloPayload, protocolVersion: number): Promise<boolean>;
  seen(agentId: string): Promise<boolean>;
  disconnected(agentId: string): Promise<void>;
}

/** For an API with no database, as in tests of the protocol alone. */
export const NO_PRESENCE: AgentPresence = {
  connected: async () => true,
  seen: async () => true,
  disconnected: async () => undefined,
};

/** What is done with registration messages. Every call is for the agent's active connection. */
export interface AgentOperationsHandler {
  synced(agentId: string, payload: RegistrationSyncPayload): Promise<void>;
  progress(agentId: string, payload: RegistrationProgressPayload): Promise<void>;
  result(agentId: string, payload: RegistrationResultPayload): Promise<void>;
  failed(agentId: string, payload: RegistrationErrorPayload): Promise<void>;
  cleanedUp(agentId: string, payload: RegistrationCleanupPayload): Promise<void>;
  healthResult(agentId: string, payload: RepositoryHealthResultPayload): Promise<void>;
  agentRevoked(agentId: string): Promise<void>;
  close(): void;
}

/** What is done with restore messages. Every call is for the agent's active connection. */
export interface AgentRestoresHandler {
  synced(agentId: string, payload: RestoreSyncPayload): Promise<void>;
  progress(agentId: string, payload: RestoreProgressPayload): Promise<void>;
  result(agentId: string, payload: RestoreResultPayload): Promise<void>;
  failed(agentId: string, payload: RestoreErrorPayload): Promise<void>;
  discovered(
    agentId: string,
    report: {
      emulators: readonly { emulatorType: string; status: string; truncated: boolean }[];
      vms: readonly { emulatorType: string; vmName: string }[];
    },
  ): Promise<void>;
  agentRevoked(agentId: string): Promise<void>;
}

/** What is done with execution and verification messages. Every call is for the active connection. */
export interface AgentExecutionHandler {
  synced(agentId: string, payload: ExecutionSyncPayload): Promise<void>;
  status(agentId: string, payload: VmExecutionStatusPayload): Promise<void>;
  verifyResult(agentId: string, payload: VmVerifyResultPayload): Promise<void>;
  agentRevoked(agentId: string): Promise<void>;
}

/** What is done with Remote Snapshot working-copy messages. Every call is for the active connection. */
export interface AgentWorkspacesHandler {
  synced(agentId: string, workspaceIds: readonly string[]): Promise<void>;
  discardResult(agentId: string, payload: WorkspaceDiscardResultPayload): Promise<void>;
  agentRevoked(agentId: string): Promise<void>;
}

/** What is done with storage cleanup messages (decision 0041). Every call is for the active connection. */
export interface AgentCleanupHandler {
  /** After the restore coordinator has handled the same sync. */
  synced(agentId: string, payload: RestoreSyncPayload): Promise<void>;
  removalResult(agentId: string, payload: LocalCopyRemoveResultPayload): Promise<void>;
  archiveDeleteResult(agentId: string, payload: ArchiveDeleteResultPayload): Promise<void>;
  agentRevoked(agentId: string): Promise<void>;
}

export interface AgentHubOptions {
  presence: AgentPresence;
  heartbeatIntervalSeconds: number;
  /** How long a new connection has to say hello. */
  helloTimeoutMs: number;
  /** A connection that sends nothing for this long is treated as dead. */
  silenceTimeoutMs: number;
  discoveryTimeoutMs: number;
  /** Far above what the protocol needs, this only stops a misbehaving peer. */
  maxMessagesPerMinute: number;
  /** How long a peer gets to complete the closing handshake before its socket is destroyed. */
  closeGraceMs: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;

const DEFAULT_OPTIONS: Omit<AgentHubOptions, 'presence'> = {
  heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  helloTimeoutMs: 10_000,
  // Two missed heartbeats and some allowance for a slow network.
  silenceTimeoutMs: (2 * DEFAULT_HEARTBEAT_INTERVAL_SECONDS + 15) * 1000,
  discoveryTimeoutMs: 30_000,
  maxMessagesPerMinute: 120,
  closeGraceMs: 2_000,
};

interface Connection {
  id: string;
  agentId: string;
  socket: WebSocket;
  log: FastifyBaseLogger;
  /** Set once `agent.hello` has been accepted. Only then can it be the agent's active connection. */
  hello: AgentHelloPayload | null;
  /** Messages are handled strictly in order, since handling one can involve the database. */
  queue: Promise<void>;
  lastReceivedAt: number;
  windowStartedAt: number;
  windowMessages: number;
  helloTimer: NodeJS.Timeout | null;
  silenceTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** Set once this connection has sent `agent.registration_sync`, which older agents never do. */
  registrationCapable: boolean;
  /** What `agent.restore_sync` said this connection's agent can do. Older agents never send it. */
  restoreCapabilities: RestoreSyncPayload['capabilities'] | null;
  /** What `agent.execution_sync` said this connection's agent can launch. Older agents never send it. */
  executionCapabilities: ExecutionSyncPayload['capabilities'] | null;
  /** Whether `agent.registration_sync` said this agent can create snapshots. */
  snapshotCapable: boolean;
  /** Whether `agent.restore_sync` listed working copies, which only agents that keep them do. */
  workspacesSupported: boolean;
}

/** What `ws` calls a frame over its `maxPayload`. */
const OVERSIZED_FRAME = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

type ServerMessageBody = Pick<ServerMessage, 'type' | 'payload'>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Every connected agent, and which connection is each agent's active one. See "Connections" in the
 * protocol documentation.
 *
 * The newest connection wins. A connection becomes active when its hello is accepted, and replaces
 * any previous one, which is closed with `superseded`. Everything keyed by agent checks that the
 * connection concerned is still the active one, so a stale socket that finally closes cannot mark the
 * agent offline or disturb what the new connection is doing.
 */
export class AgentHub {
  readonly options: AgentHubOptions;
  readonly discovery: DiscoveryCoordinator;
  private readonly connections = new Set<Connection>();
  private readonly active = new Map<string, Connection>();
  private readonly pendingPresence = new Set<Promise<unknown>>();
  private operations: AgentOperationsHandler | null = null;
  private restores: AgentRestoresHandler | null = null;
  private execution: AgentExecutionHandler | null = null;
  private captures: import('../execution/captures.js').CaptureCoordinator | null = null;
  setCaptures(captures: import('../execution/captures.js').CaptureCoordinator): void {
    this.captures = captures;
  }
  private workspaces: AgentWorkspacesHandler | null = null;
  private cleanup: AgentCleanupHandler | null = null;
  /** What each agent last said about its screenshots. Stale once it is offline, and says when it spoke. */
  private readonly mediaStatuses = new Map<
    string,
    { reportedAt: string; vms: MediaSyncStatusPayload['vms'] }
  >();

  constructor(options: Partial<AgentHubOptions> & Pick<AgentHubOptions, 'presence'>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.discovery = new DiscoveryCoordinator({
      timeoutMs: this.options.discoveryTimeoutMs,
      send: (connectionId, operationId) => this.sendDiscoveryRequest(connectionId, operationId),
    });
  }

  isOnline(agentId: string): boolean {
    return this.active.has(agentId);
  }

  setOperations(operations: AgentOperationsHandler): void {
    this.operations = operations;
  }

  setRestores(restores: AgentRestoresHandler): void {
    this.restores = restores;
  }

  setExecution(execution: AgentExecutionHandler): void {
    this.execution = execution;
  }

  setWorkspaces(workspaces: AgentWorkspacesHandler): void {
    this.workspaces = workspaces;
  }

  setCleanup(cleanup: AgentCleanupHandler): void {
    this.cleanup = cleanup;
  }

  isSnapshotCapable(agentId: string): boolean {
    return this.active.get(agentId)?.snapshotCapable ?? false;
  }

  workspacesSupported(agentId: string): boolean {
    return this.active.get(agentId)?.workspacesSupported ?? false;
  }

  executionCapabilities(agentId: string): ExecutionSyncPayload['capabilities'] | null {
    return this.active.get(agentId)?.executionCapabilities ?? null;
  }

  restoreCapabilities(agentId: string): RestoreSyncPayload['capabilities'] | null {
    return this.active.get(agentId)?.restoreCapabilities ?? null;
  }

  isRegistrationCapable(agentId: string): boolean {
    return this.active.get(agentId)?.registrationCapable ?? false;
  }

  activeConnectionId(agentId: string): string | null {
    return this.active.get(agentId)?.id ?? null;
  }

  mediaStatus(agentId: string, vm: VmIdentity): AdminMediaSyncResponse['agents'][number]['status'] {
    const report = this.mediaStatuses.get(agentId);
    const entry = report?.vms.find(
      (item) =>
        item.emulatorType === vm.emulatorType && vmNameKey(item.vmName) === vmNameKey(vm.vmName),
    );
    if (!report || !entry) return null;
    const { pending, uploading, synchronized, failed, lastError } = entry;
    return { pending, uploading, synchronized, failed, lastError, reportedAt: report.reportedAt };
  }

  /** Sends to the agent's active connection, or returns false if it has none. */
  sendToAgent(agentId: string, message: ServerMessageBody): boolean {
    const connection = this.active.get(agentId);
    return connection ? this.send(connection, message) : false;
  }

  /** Starts a scan on the agent's active connection, or returns `null` if it has none. */
  startDiscovery(agentId: string): DiscoveryRecord | null {
    const connection = this.active.get(agentId);
    return connection ? this.discovery.start(agentId, connection.id) : null;
  }

  /** Runs for every authenticated socket. The identity comes from the credential, and nowhere else. */
  attach(socket: WebSocket, agentId: string, log: FastifyBaseLogger): void {
    const now = Date.now();
    const connection: Connection = {
      id: randomUUID(),
      agentId,
      socket,
      log,
      hello: null,
      queue: Promise.resolve(),
      lastReceivedAt: now,
      windowStartedAt: now,
      windowMessages: 0,
      helloTimer: null,
      silenceTimer: null,
      closed: false,
      registrationCapable: false,
      restoreCapabilities: null,
      executionCapabilities: null,
      snapshotCapable: false,
      workspacesSupported: false,
    };
    this.connections.add(connection);
    log.info({ agentId, connectionId: connection.id }, 'Agent connected');

    connection.helloTimer = setTimeout(() => {
      this.sendError(connection, 'hello_timeout', 'Expected agent.hello');
      this.drop(connection, WS_CLOSE_CODES.timedOut, 'hello timeout');
    }, this.options.helloTimeoutMs);
    connection.helloTimer.unref();
    this.scheduleSilenceCheck(connection);

    socket.on('message', (data, isBinary) => this.onFrame(connection, data, isBinary));
    socket.on('close', (code) => this.onClosed(connection, code));
    socket.on('error', (error) => {
      log.warn({ agentId, err: error }, 'Agent socket error');
      // The library has already refused the frame. It only reports the close code to the peer.
      if ((error as NodeJS.ErrnoException).code === OVERSIZED_FRAME) {
        this.drop(connection, 1009, 'message too large');
      }
    });
  }

  /** Disconnects every connection of a revoked agent, and fails what it was doing. */
  revoke(agentId: string): void {
    this.discovery.failRunning(agentId, 'agent_revoked');
    this.operationsRevoked(agentId);
    this.mediaStatuses.delete(agentId);
    for (const connection of [...this.connections]) {
      if (connection.agentId !== agentId) continue;
      this.sendError(connection, 'agent_revoked', 'This agent has been revoked');
      this.drop(connection, WS_CLOSE_CODES.agentRevoked, 'revoked');
    }
  }

  /** Closes everything for a server shutdown, and waits for presence to reach the database. */
  async shutdown(): Promise<void> {
    this.discovery.close();
    this.operations?.close();
    for (const connection of [...this.connections]) {
      this.drop(connection, 1001, 'server shutting down');
    }
    await Promise.allSettled([...this.pendingPresence]);
  }

  private sendDiscoveryRequest(connectionId: string, operationId: string): boolean {
    for (const connection of this.active.values()) {
      if (connection.id !== connectionId) continue;
      return this.send(connection, {
        type: 'server.discovery_request',
        payload: discoveryRequestPayloadSchema.parse({ operationId }),
      });
    }
    return false;
  }

  private send(
    connection: Connection,
    message: ServerMessageBody,
    correlationId?: string,
  ): boolean {
    if (connection.closed || connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ...(correlationId ? { correlationId } : {}),
        sentAt: new Date().toISOString(),
        ...message,
      }),
    );
    return true;
  }

  private sendError(
    connection: Connection,
    code: string,
    message: string,
    correlationId?: string,
  ): void {
    this.send(connection, { type: 'server.error', payload: { code, message } }, correlationId);
  }

  private onFrame(connection: Connection, data: unknown, isBinary: boolean): void {
    connection.lastReceivedAt = Date.now();
    if (!this.withinMessageRate(connection)) {
      this.sendError(connection, 'too_many_messages', 'Too many messages');
      this.drop(connection, WS_CLOSE_CODES.tooManyMessages, 'too many messages');
      return;
    }
    if (isBinary) {
      this.sendError(connection, 'invalid_message', 'Binary messages are not supported');
      this.drop(connection, WS_CLOSE_CODES.invalidMessage, 'binary message');
      return;
    }
    const raw = String(data);
    connection.queue = connection.queue
      .then(() => this.handleText(connection, raw))
      .catch((error: unknown) => {
        connection.log.error({ agentId: connection.agentId, err: error }, 'Agent message failed');
        this.drop(connection, 1011, 'internal error');
      });
  }

  private withinMessageRate(connection: Connection): boolean {
    const now = Date.now();
    if (now - connection.windowStartedAt >= 60_000) {
      connection.windowStartedAt = now;
      connection.windowMessages = 0;
    }
    connection.windowMessages += 1;
    return connection.windowMessages <= this.options.maxMessagesPerMinute;
  }

  private async handleText(connection: Connection, raw: string): Promise<void> {
    if (connection.closed) return;
    const { agentId, log } = connection;

    const envelope = envelopeSchema.safeParse(parseJson(raw));
    if (!envelope.success) {
      this.sendError(connection, 'invalid_message', 'Message is not a valid envelope');
      this.drop(connection, WS_CLOSE_CODES.invalidMessage, 'invalid message');
      return;
    }
    const { id, protocolVersion, type } = envelope.data;

    if (protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(
        connection,
        'unsupported_protocol_version',
        `Server speaks ${PROTOCOL_VERSION}`,
        id,
      );
      this.drop(connection, WS_CLOSE_CODES.unsupportedProtocolVersion, 'unsupported protocol');
      return;
    }

    const message = agentMessageSchema.safeParse(envelope.data);
    if (!message.success) {
      // Unknown types are refused rather than ignored. Nothing here can trigger a control action.
      log.warn({ agentId, type }, 'Rejected agent message');
      this.failMalformedReport(connection, envelope.data);
      this.sendError(connection, 'unsupported_message', 'Unsupported or malformed message', id);
      return;
    }
    await this.handleMessage(connection, message.data);
  }

  /** A report that fails validation must end its operation now, not leave it to time out. */
  private failMalformedReport(connection: Connection, envelope: Envelope): void {
    if (envelope.type !== 'agent.discovery_result' && envelope.type !== 'agent.discovery_error') {
      return;
    }
    const { operationId } = (envelope.payload ?? {}) as { operationId?: unknown };
    if (typeof operationId === 'string') {
      this.discovery.acceptFailure(
        connection.agentId,
        connection.id,
        operationId,
        'malformed_result',
      );
    }
  }

  private async handleMessage(connection: Connection, message: AgentMessage): Promise<void> {
    const { agentId, log } = connection;
    switch (message.type) {
      case 'agent.hello':
        await this.handleHello(connection, message.payload, message.id);
        break;
      case 'agent.heartbeat':
        // Being active is what makes a connection count; an earlier heartbeat is merely answered.
        if (this.active.get(agentId) === connection) {
          const allowed = await this.options.presence.seen(agentId).catch((error: unknown) => {
            // A database hiccup is no reason to cut off an agent. The next heartbeat tries again.
            log.warn({ agentId, err: error }, 'Cannot record that an agent was seen');
            return true;
          });
          if (!allowed) {
            this.refuseRevoked(connection);
            return;
          }
        }
        this.send(connection, { type: 'server.heartbeat_ack', payload: {} }, message.id);
        break;
      case 'agent.discovery_result': {
        const platform = this.activePlatform(connection);
        const wanted =
          platform !== null &&
          this.discovery.acceptResult(agentId, connection.id, platform, message.payload);
        if (!wanted) {
          log.warn({ agentId, id: message.id }, 'Ignored an unwanted discovery result');
        } else {
          // Housekeeping only. A database hiccup must not cost the connection its discovery result.
          await this.restores?.discovered(agentId, message.payload).catch((error: unknown) => {
            log.warn({ agentId, err: error }, 'Cannot record what a discovery found');
          });
        }
        break;
      }
      case 'agent.discovery_error': {
        const { operationId, code } = message.payload;
        const failure = code === 'busy' ? 'agent_busy' : 'agent_error';
        if (!this.discovery.acceptFailure(agentId, connection.id, operationId, failure)) {
          log.warn({ agentId, id: message.id }, 'Ignored an unwanted discovery error');
        }
        break;
      }
      case 'agent.media_sync_status':
        // Informational. A stale connection's word counts for nothing here either.
        if (this.active.get(agentId) === connection) {
          this.mediaStatuses.set(agentId, {
            reportedAt: new Date().toISOString(),
            vms: message.payload.vms,
          });
        }
        break;
      case 'agent.registration_sync':
      case 'agent.registration_progress':
      case 'agent.registration_result':
      case 'agent.registration_error':
      case 'agent.registration_cleanup':
      case 'agent.repository_health_result':
        await this.handleOperationMessage(connection, message);
        break;
      case 'agent.restore_sync':
      case 'agent.restore_progress':
      case 'agent.restore_result':
      case 'agent.restore_error':
        await this.handleRestoreMessage(connection, message);
        break;
      case 'agent.qemu_capture':
        if (this.active.get(agentId) === connection) {
          try {
            await this.captures?.report(agentId, message.payload);
          } catch (error) {
            connection.log.error(
              { err: error, operationId: message.payload.operationId },
              'Cannot record screenshot report; awaiting replay',
            );
          }
        }
        return;
      case 'agent.execution_sync':
      case 'agent.vm_execution_status':
      case 'agent.vm_verify_result':
        await this.handleExecutionMessage(connection, message);
        break;
      case 'agent.local_copy_remove_result':
      case 'agent.archive_delete_result':
        if (this.active.get(agentId) !== connection || !this.cleanup) {
          connection.log.warn({ agentId }, 'Ignored a message from an inactive connection');
          break;
        }
        try {
          if (message.type === 'agent.local_copy_remove_result') {
            await this.cleanup.removalResult(agentId, message.payload);
          } else {
            await this.cleanup.archiveDeleteResult(agentId, message.payload);
          }
        } catch (error) {
          // No answer: the agent reports again.
          connection.log.error({ agentId, err: error }, 'Cannot handle an agent report');
        }
        break;
      case 'agent.workspace_discard_result':
        if (this.active.get(agentId) !== connection || !this.workspaces) {
          connection.log.warn({ agentId }, 'Ignored a message from an inactive connection');
          break;
        }
        try {
          await this.workspaces.discardResult(agentId, message.payload);
        } catch (error) {
          connection.log.error({ agentId, err: error }, 'Cannot handle an agent report');
        }
        break;
    }
  }

  /**
   * A stale connection's word counts for nothing. A database failure here is not the agent's fault, so
   * it does not close the connection: no answer is sent, and the agent repeats its report.
   */
  private async handleOperationMessage(
    connection: Connection,
    message: Extract<
      AgentMessage,
      {
        type:
          | 'agent.registration_sync'
          | 'agent.registration_progress'
          | 'agent.registration_result'
          | 'agent.registration_error'
          | 'agent.registration_cleanup'
          | 'agent.repository_health_result';
      }
    >,
  ): Promise<void> {
    const { agentId, log } = connection;
    if (this.active.get(agentId) !== connection || !this.operations) {
      log.warn({ agentId, type: message.type }, 'Ignored a message from an inactive connection');
      return;
    }
    const operations = this.operations;
    try {
      switch (message.type) {
        case 'agent.registration_sync':
          connection.registrationCapable = true;
          connection.snapshotCapable = message.payload.snapshots === true;
          await operations.synced(agentId, message.payload);
          break;
        case 'agent.registration_progress':
          await operations.progress(agentId, message.payload);
          break;
        case 'agent.registration_result':
          await operations.result(agentId, message.payload);
          break;
        case 'agent.registration_error':
          await operations.failed(agentId, message.payload);
          break;
        case 'agent.registration_cleanup':
          await operations.cleanedUp(agentId, message.payload);
          break;
        case 'agent.repository_health_result':
          await operations.healthResult(agentId, message.payload);
          break;
      }
    } catch (error) {
      log.error({ agentId, type: message.type, err: error }, 'Cannot handle an agent report');
    }
  }

  /** As for registration: a stale connection counts for nothing, and a database failure gets no answer. */
  private async handleRestoreMessage(
    connection: Connection,
    message: Extract<
      AgentMessage,
      {
        type:
          | 'agent.restore_sync'
          | 'agent.restore_progress'
          | 'agent.restore_result'
          | 'agent.restore_error';
      }
    >,
  ): Promise<void> {
    const { agentId, log } = connection;
    if (this.active.get(agentId) !== connection || !this.restores) {
      log.warn({ agentId, type: message.type }, 'Ignored a message from an inactive connection');
      return;
    }
    const restores = this.restores;
    try {
      switch (message.type) {
        case 'agent.restore_sync':
          connection.restoreCapabilities = message.payload.capabilities;
          connection.workspacesSupported = message.payload.workspaces !== undefined;
          await restores.synced(agentId, message.payload);
          if (message.payload.workspaces && this.workspaces) {
            await this.workspaces.synced(agentId, message.payload.workspaces);
          }
          await this.cleanup?.synced(agentId, message.payload);
          break;
        case 'agent.restore_progress':
          await restores.progress(agentId, message.payload);
          break;
        case 'agent.restore_result':
          await restores.result(agentId, message.payload);
          break;
        case 'agent.restore_error':
          await restores.failed(agentId, message.payload);
          break;
      }
    } catch (error) {
      log.error({ agentId, type: message.type, err: error }, 'Cannot handle an agent report');
    }
  }

  /** As for restores: a stale connection counts for nothing, and a database failure gets no answer. */
  private async handleExecutionMessage(
    connection: Connection,
    message: Extract<
      AgentMessage,
      { type: 'agent.execution_sync' | 'agent.vm_execution_status' | 'agent.vm_verify_result' }
    >,
  ): Promise<void> {
    const { agentId, log } = connection;
    if (this.active.get(agentId) !== connection || !this.execution) {
      log.warn({ agentId, type: message.type }, 'Ignored a message from an inactive connection');
      return;
    }
    const execution = this.execution;
    try {
      switch (message.type) {
        case 'agent.execution_sync':
          connection.executionCapabilities = message.payload.capabilities;
          await execution.synced(agentId, message.payload);
          await this.captures?.synced(agentId);
          break;
        case 'agent.vm_execution_status':
          await execution.status(agentId, message.payload);
          break;
        case 'agent.vm_verify_result':
          await execution.verifyResult(agentId, message.payload);
          break;
      }
    } catch (error) {
      log.error({ agentId, type: message.type, err: error }, 'Cannot handle an agent report');
    }
  }

  private operationsRevoked(agentId: string): void {
    if (this.execution) {
      const ended = this.execution
        .agentRevoked(agentId)
        .catch((error: unknown) => {
          for (const connection of this.connections) {
            if (connection.agentId === agentId) {
              connection.log.error(
                { agentId, err: error },
                'Cannot end a revoked agent’s sessions',
              );
            }
          }
        })
        .finally(() => this.pendingPresence.delete(ended));
      this.pendingPresence.add(ended);
    }
    if (this.restores) {
      const ended = this.restores
        .agentRevoked(agentId)
        .catch((error: unknown) => {
          for (const connection of this.connections) {
            if (connection.agentId === agentId) {
              connection.log.error(
                { agentId, err: error },
                'Cannot end a revoked agent’s restores',
              );
            }
          }
        })
        .finally(() => this.pendingPresence.delete(ended));
      this.pendingPresence.add(ended);
    }
    if (this.cleanup) {
      const ended = this.cleanup
        .agentRevoked(agentId)
        .catch((error: unknown) => {
          for (const connection of this.connections) {
            if (connection.agentId === agentId) {
              connection.log.error(
                { agentId, err: error },
                'Cannot end a revoked agent’s removals',
              );
            }
          }
        })
        .finally(() => this.pendingPresence.delete(ended));
      this.pendingPresence.add(ended);
    }
    if (this.workspaces) {
      const ended = this.workspaces
        .agentRevoked(agentId)
        .catch((error: unknown) => {
          for (const connection of this.connections) {
            if (connection.agentId === agentId) {
              connection.log.error(
                { agentId, err: error },
                'Cannot end a revoked agent’s working copies',
              );
            }
          }
        })
        .finally(() => this.pendingPresence.delete(ended));
      this.pendingPresence.add(ended);
    }
    if (!this.operations) return;
    const update = this.operations
      .agentRevoked(agentId)
      .catch((error: unknown) => {
        for (const connection of this.connections) {
          if (connection.agentId === agentId) {
            connection.log.error({ agentId, err: error }, 'Cannot end a revoked agent’s work');
          }
        }
      })
      .finally(() => this.pendingPresence.delete(update));
    this.pendingPresence.add(update);
  }

  private activePlatform(connection: Connection): Platform | null {
    const active = this.active.get(connection.agentId) === connection;
    return active && connection.hello ? connection.hello.platform : null;
  }

  private async handleHello(
    connection: Connection,
    hello: AgentHelloPayload,
    messageId: string,
  ): Promise<void> {
    const { agentId, log } = connection;
    if (connection.hello) {
      this.sendError(
        connection,
        'already_greeted',
        'This connection already said hello',
        messageId,
      );
      return;
    }
    // This also closes the race with a revocation that came after the credential was checked.
    const allowed = await this.options.presence.connected(agentId, hello, PROTOCOL_VERSION);
    if (connection.closed) return;
    if (!allowed) {
      this.refuseRevoked(connection);
      return;
    }

    if (connection.helloTimer) clearTimeout(connection.helloTimer);
    connection.helloTimer = null;
    connection.hello = hello;

    const previous = this.active.get(agentId);
    this.active.set(agentId, connection);
    if (previous) {
      log.warn({ agentId, connectionId: previous.id }, 'Newer connection replaces this agent’s');
      this.discovery.connectionLost(agentId, previous.id, 'agent_disconnected');
      this.sendError(previous, 'superseded', 'Another connection took over this agent');
      this.drop(previous, WS_CLOSE_CODES.superseded, 'superseded');
    }

    log.info({ agentId, connectionId: connection.id, ...hello }, 'Agent said hello');
    this.send(
      connection,
      {
        type: 'server.welcome',
        payload: { agentId, heartbeatIntervalSeconds: this.options.heartbeatIntervalSeconds },
      },
      messageId,
    );
  }

  private refuseRevoked(connection: Connection): void {
    this.discovery.failRunning(connection.agentId, 'agent_revoked');
    this.operationsRevoked(connection.agentId);
    this.sendError(connection, 'agent_revoked', 'This agent has been revoked');
    this.drop(connection, WS_CLOSE_CODES.agentRevoked, 'revoked');
  }

  private scheduleSilenceCheck(connection: Connection): void {
    const remaining = connection.lastReceivedAt + this.options.silenceTimeoutMs - Date.now();
    connection.silenceTimer = setTimeout(
      () => {
        if (connection.closed) return;
        if (Date.now() - connection.lastReceivedAt >= this.options.silenceTimeoutMs) {
          connection.log.warn({ agentId: connection.agentId }, 'Agent went silent');
          this.drop(connection, WS_CLOSE_CODES.timedOut, 'no heartbeat');
        } else {
          this.scheduleSilenceCheck(connection);
        }
      },
      Math.max(remaining, 1),
    );
    connection.silenceTimer.unref();
  }

  /**
   * Takes a connection out of service at once, then closes its socket. A half-open peer never answers
   * the closing handshake, so the socket is destroyed if it has not closed shortly after.
   */
  private drop(connection: Connection, code: number, reason: string): void {
    this.release(connection, code);
    const { socket } = connection;
    if (socket.readyState === socket.CLOSED) return;
    socket.close(code, reason);
    setTimeout(() => {
      if (socket.readyState !== socket.CLOSED) socket.terminate();
    }, this.options.closeGraceMs).unref();
  }

  private onClosed(connection: Connection, code: number): void {
    connection.log.info({ agentId: connection.agentId, code }, 'Agent disconnected');
    this.release(connection, code);
  }

  /** Idempotent. Only a connection that is still active can change the agent's presence. */
  private release(connection: Connection, code: number): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.helloTimer) clearTimeout(connection.helloTimer);
    if (connection.silenceTimer) clearTimeout(connection.silenceTimer);
    this.connections.delete(connection);

    const { agentId } = connection;
    this.discovery.connectionLost(
      agentId,
      connection.id,
      code === 1009 ? 'result_too_large' : 'agent_disconnected',
    );
    if (this.active.get(agentId) !== connection) return;
    this.active.delete(agentId);
    const update = this.options.presence
      .disconnected(agentId)
      .catch((error: unknown) => {
        connection.log.warn({ agentId, err: error }, 'Cannot record a disconnection');
      })
      .finally(() => this.pendingPresence.delete(update));
    this.pendingPresence.add(update);
  }
}
