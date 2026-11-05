import { randomUUID } from 'node:crypto';
import {
  hostCompatibility,
  type DiscoveryEmulatorReport,
  type DiscoveryFailureCode,
  type DiscoveryOperationStatus,
  type DiscoveryResultPayload,
  type DiscoverySkipped,
  type EmulatorType,
  type Platform,
} from '@emucat/contracts';

/** Everything known about one operation. Held in memory only: discovery is not persisted. */
export interface DiscoveryRecord {
  id: string;
  agentId: string;
  /** Only this connection's answer counts, however plausible another one looks. */
  connectionId: string;
  status: DiscoveryOperationStatus;
  startedAt: Date;
  finishedAt: Date | null;
  failure: { code: DiscoveryFailureCode; message: string } | null;
  hostPlatform: Platform | null;
  emulators: DiscoveryEmulatorReport[];
  vms: {
    emulatorType: EmulatorType;
    vmName: string;
    markers: string[];
    hostCompatible: boolean | null;
  }[];
  skipped: DiscoverySkipped[];
}

const FAILURE_MESSAGES: Record<DiscoveryFailureCode, string> = {
  timeout: 'The agent did not answer in time.',
  agent_disconnected: 'The agent disconnected before it finished.',
  agent_revoked: 'The agent was revoked.',
  agent_busy: 'The agent is already scanning.',
  agent_error: 'The agent could not complete the scan.',
  malformed_result: 'The agent sent a report that failed validation.',
  result_too_large: 'The agent sent a report larger than the protocol allows.',
};

export interface DiscoveryOptions {
  timeoutMs: number;
  /** Delivers the request to the connection, or returns false if it cannot be sent. */
  send: (connectionId: string, operationId: string) => boolean;
  onFinished?: (record: DiscoveryRecord) => void;
}

/**
 * Tracks on-demand scans. There is at most one running operation per agent, and only the latest per
 * agent is kept. An answer changes something only if it is for the running operation and comes on the
 * connection that was asked, so duplicates, late answers and answers from elsewhere are all ignored.
 */
export class DiscoveryCoordinator {
  private readonly latest = new Map<string, DiscoveryRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: DiscoveryOptions) {}

  /** Starts an operation, or returns the one already running: concurrent requests share a scan. */
  start(agentId: string, connectionId: string): DiscoveryRecord {
    const current = this.latest.get(agentId);
    if (current?.status === 'running') return current;

    const record: DiscoveryRecord = {
      id: randomUUID(),
      agentId,
      connectionId,
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      failure: null,
      hostPlatform: null,
      emulators: [],
      vms: [],
      skipped: [],
    };
    this.latest.set(agentId, record);
    const timer = setTimeout(() => this.fail(record, 'timeout'), this.options.timeoutMs);
    timer.unref();
    this.timers.set(record.id, timer);
    if (!this.options.send(connectionId, record.id)) this.fail(record, 'agent_disconnected');
    return record;
  }

  get(agentId: string): DiscoveryRecord | null {
    return this.latest.get(agentId) ?? null;
  }

  /** Returns false if the report was not wanted. The platform comes from the connection's hello. */
  acceptResult(
    agentId: string,
    connectionId: string,
    platform: Platform,
    report: DiscoveryResultPayload,
  ): boolean {
    const record = this.running(agentId, connectionId, report.operationId);
    if (!record) return false;
    record.hostPlatform = platform;
    record.emulators = report.emulators;
    record.skipped = report.skipped;
    // Recomputed, not believed: it follows from the markers and the host this connection declared.
    record.vms = report.vms.map((vm) => ({
      emulatorType: vm.emulatorType,
      vmName: vm.vmName,
      markers: vm.markers,
      hostCompatible: hostCompatibility(vm.emulatorType, vm.markers, platform),
    }));
    this.finish(record, 'completed');
    return true;
  }

  /** The agent reported, or was found to have made, a failure of this operation. */
  acceptFailure(
    agentId: string,
    connectionId: string,
    operationId: string,
    code: DiscoveryFailureCode,
  ): boolean {
    const record = this.running(agentId, connectionId, operationId);
    if (!record) return false;
    this.fail(record, code);
    return true;
  }

  /** The operation running on this connection fails, because the connection has gone. */
  connectionLost(agentId: string, connectionId: string, code: DiscoveryFailureCode): void {
    const record = this.latest.get(agentId);
    if (record?.status === 'running' && record.connectionId === connectionId) {
      this.fail(record, code);
    }
  }

  /** The agent's running operation fails, whichever connection it was on. */
  failRunning(agentId: string, code: DiscoveryFailureCode): void {
    const record = this.latest.get(agentId);
    if (record?.status === 'running') this.fail(record, code);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private running(
    agentId: string,
    connectionId: string,
    operationId: string,
  ): DiscoveryRecord | null {
    const record = this.latest.get(agentId);
    const wanted =
      record?.status === 'running' &&
      record.id === operationId &&
      record.connectionId === connectionId;
    return wanted ? record : null;
  }

  private fail(record: DiscoveryRecord, code: DiscoveryFailureCode): void {
    if (record.status !== 'running') return;
    record.failure = { code, message: FAILURE_MESSAGES[code] };
    this.finish(record, 'failed');
  }

  private finish(record: DiscoveryRecord, status: DiscoveryOperationStatus): void {
    record.status = status;
    record.finishedAt = new Date();
    const timer = this.timers.get(record.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(record.id);
    this.options.onFinished?.(record);
  }
}
