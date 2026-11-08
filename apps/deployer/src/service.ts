import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployerConfig } from './config.ts';
import {
  deriveOperation,
  isOperationId,
  type OperationRecord,
  type UpdateEvent,
  type UpdateOperation,
  OperationStore,
} from './operations.ts';
import type { Sanitizer } from './sanitize.ts';

/** What the service needs from the host. Replaced by fakes in tests. */
export interface HostRunner {
  /** Starts `emucatctl update` detached, so that it outlives this service. Returns its process ID. */
  startUpdate(operationId: string, expectedCommit: string, requestedBy: string): number;
  isAlive(pid: number): boolean;
  /** Whether some process, from this service or the command line, holds the deployment lock. */
  lockHeld(): Promise<boolean>;
  /** Runs `emucatctl check-update --json`. */
  checkUpdate(): Promise<CheckResult>;
  /** Whether the application answers as ready through its ingress. */
  healthy(): Promise<boolean>;
}

export interface CheckResult {
  remote: { commit: string; subject: string; committedAt: string | null };
}

export class ServiceError extends Error {
  override readonly name = 'ServiceError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DeploymentStatus {
  environment: string;
  branch: string;
  updatesEnabled: boolean;
  current: { commit: string; deployedAt: string; operationId: string | null } | null;
  latest: { commit: string; subject: string; committedAt: string | null; checkedAt: string } | null;
  updateAvailable: boolean | null;
  activeOperation: UpdateOperation | null;
  lastOperation: UpdateOperation | null;
  lastSuccess: Summary | null;
  lastFailure: Summary | null;
}

interface Summary {
  operationId: string;
  commit: string | null;
  finishedAt: string;
  message: string | null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const REQUESTER = /^[A-Za-z0-9._-]{1,64}$/;
/** How long a finished update may take to answer as healthy before it counts as failed. */
const VERIFY_GRACE_MS = 90_000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_LINES = 4000;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function pidOf(record: OperationRecord | null, events: UpdateEvent[]): number | null {
  if (record?.pid) return record.pid;
  const event = events.find((candidate) => candidate.key === 'pid');
  const pid = event ? Number(event.value) : NaN;
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export interface ServiceOptions {
  config: DeployerConfig;
  runner: HostRunner;
  sanitize: Sanitizer;
  now?: () => Date;
}

/**
 * The deployment service's behavior, independent of its transport. It never runs anything but the fixed
 * `emucatctl` subcommands, never accepts a ref, repository or path, and refuses to start an update while
 * another one, from anywhere, is running.
 */
export class DeploymentService {
  readonly store: OperationStore;
  private readonly config: DeployerConfig;
  private readonly runner: HostRunner;
  private readonly sanitize: Sanitizer;
  private readonly now: () => Date;
  /** Serializes starting an update, so two simultaneous requests cannot both pass the checks. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.config = options.config;
    this.runner = options.runner;
    this.sanitize = options.sanitize;
    this.now = options.now ?? (() => new Date());
    this.store = new OperationStore(options.config.operationsDir);
  }

  private currentRelease(): DeploymentStatus['current'] {
    const value = readJson<{ commit?: unknown; deployedAt?: unknown; operationId?: unknown }>(
      join(this.config.stateDir, 'current-release.json'),
    );
    if (!value || typeof value.commit !== 'string' || !COMMIT.test(value.commit)) return null;
    return {
      commit: value.commit,
      deployedAt:
        typeof value.deployedAt === 'string' ? value.deployedAt : new Date(0).toISOString(),
      operationId:
        typeof value.operationId === 'string' && isOperationId(value.operationId)
          ? value.operationId
          : null,
    };
  }

  private latestRemote(): DeploymentStatus['latest'] {
    const value = readJson<DeploymentStatus['latest']>(join(this.config.stateDir, 'remote.json'));
    if (!value || typeof value.commit !== 'string' || !COMMIT.test(value.commit)) return null;
    return {
      commit: value.commit,
      subject: this.sanitize(String(value.subject ?? '')).slice(0, 200),
      committedAt: typeof value.committedAt === 'string' ? value.committedAt : null,
      checkedAt: String(value.checkedAt),
    };
  }

  operation(id: string): UpdateOperation | null {
    if (!isOperationId(id) || !this.store.exists(id)) return null;
    const record = this.store.record(id);
    const events = this.store.events(id);
    const pid = pidOf(record, events);
    const alive = pid !== null && this.runner.isAlive(pid);
    const operation = deriveOperation(id, record, events, alive);
    if (operation.error) {
      operation.error = {
        code: operation.error.code,
        message: this.sanitize(operation.error.message),
      };
    }
    return operation;
  }

  operations(): UpdateOperation[] {
    return this.store
      .ids()
      .map((id) => this.operation(id))
      .filter((operation): operation is UpdateOperation => operation !== null)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  status(): DeploymentStatus {
    const operations = this.operations();
    const current = this.currentRelease();
    const latest = this.latestRemote();
    const summary = (operation: UpdateOperation | undefined): Summary | null =>
      operation
        ? {
            operationId: operation.id,
            commit: operation.targetCommit,
            finishedAt: operation.finishedAt ?? operation.requestedAt,
            message: operation.error?.message ?? null,
          }
        : null;
    return {
      environment: this.config.environment,
      branch: this.config.branch,
      updatesEnabled: this.config.updatesEnabled,
      current,
      latest,
      updateAvailable: latest ? latest.commit !== current?.commit : null,
      activeOperation: operations.find((operation) => operation.status === 'running') ?? null,
      lastOperation: operations[0] ?? null,
      lastSuccess: summary(operations.find((operation) => operation.status === 'succeeded')),
      lastFailure: summary(operations.find((operation) => operation.status === 'failed')),
    };
  }

  private async busy(): Promise<boolean> {
    if (this.operations().some((operation) => operation.status === 'running')) return true;
    return this.runner.lockHeld();
  }

  async check(): Promise<DeploymentStatus> {
    if (await this.busy()) {
      throw new ServiceError(409, 'update_in_progress', 'An update is in progress');
    }
    // The script writes remote.json itself; this only reports the result.
    await this.runner.checkUpdate();
    return this.status();
  }

  start(request: { expectedCommit: unknown; requestedBy: unknown }): Promise<UpdateOperation> {
    const run = this.gate.then(() => this.startNow(request));
    this.gate = run.catch(() => undefined);
    return run;
  }

  private async startNow(request: {
    expectedCommit: unknown;
    requestedBy: unknown;
  }): Promise<UpdateOperation> {
    const { expectedCommit, requestedBy } = request;
    if (typeof expectedCommit !== 'string' || !COMMIT.test(expectedCommit)) {
      throw new ServiceError(400, 'invalid_request', 'expectedCommit must be a full commit ID');
    }
    if (typeof requestedBy !== 'string' || !REQUESTER.test(requestedBy)) {
      throw new ServiceError(400, 'invalid_request', 'requestedBy is not valid');
    }
    if (!this.config.updatesEnabled) {
      throw new ServiceError(
        403,
        'updates_disabled',
        'Application updates from the browser are disabled on this server',
      );
    }
    if (await this.busy()) {
      throw new ServiceError(409, 'update_in_progress', 'An update is already in progress');
    }
    const latest = this.latestRemote();
    if (!latest) {
      throw new ServiceError(409, 'not_checked', 'Check for updates first');
    }
    if (latest.commit !== expectedCommit) {
      throw new ServiceError(
        409,
        'target_changed',
        'The branch has changed since it was checked. Check for updates again.',
      );
    }
    if (this.currentRelease()?.commit === expectedCommit) {
      throw new ServiceError(409, 'already_current', 'This commit is already deployed');
    }

    const id = crypto.randomUUID();
    const record: OperationRecord = {
      id,
      requestedBy,
      requestedAt: this.now().toISOString(),
      pid: null,
      final: null,
    };
    this.store.saveRecord(record);
    try {
      record.pid = this.runner.startUpdate(id, expectedCommit, requestedBy);
      this.store.saveRecord(record);
    } catch {
      record.final = {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        error: { code: 'start_failed', message: 'The deployment command could not be started' },
      };
      this.store.saveRecord(record);
    }
    return this.operation(id) as UpdateOperation;
  }

  /**
   * Decides the outcome of operations that have stopped. A successful exit is not enough: the recorded
   * release must be the target commit, and the application must answer as ready through its ingress.
   */
  async reconcile(): Promise<void> {
    for (const id of this.store.ids()) {
      const record = this.store.record(id);
      if (!record || record.final) continue;
      const events = this.store.events(id);
      const done = events.find((event) => event.key === 'done');
      const pid = pidOf(record, events);
      if (!done) {
        if (pid !== null && this.runner.isAlive(pid)) continue;
        if (pid === null && this.now().getTime() - Date.parse(record.requestedAt) < 30_000)
          continue;
        const derived = deriveOperation(id, record, events, false);
        record.final = {
          status: 'failed',
          finishedAt: this.now().toISOString(),
          error: derived.error,
        };
        this.store.saveRecord(record);
        continue;
      }
      if (done.value !== 'succeeded') {
        record.final = { status: 'failed', finishedAt: done.at, error: null };
        this.store.saveRecord(record);
        continue;
      }
      const target = events.findLast((event) => event.key === 'target')?.value ?? null;
      const current = this.currentRelease();
      const healthy = await this.runner.healthy().catch(() => false);
      if (target !== null && current?.commit === target && healthy) {
        record.final = { status: 'succeeded', finishedAt: this.now().toISOString(), error: null };
        this.store.saveRecord(record);
        continue;
      }
      if (
        this.now().getTime() - Date.parse(done.at) < VERIFY_GRACE_MS &&
        current?.commit === target
      ) {
        continue;
      }
      record.final = {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        error: {
          code: 'verification_failed',
          message:
            current?.commit !== target
              ? 'The deployment finished, but the recorded release is not the target commit.'
              : 'The deployment finished, but the application does not answer as ready.',
        },
      };
      this.store.saveRecord(record);
    }
  }

  log(id: string): { operationId: string; lines: string[]; truncated: boolean } | null {
    if (!isOperationId(id) || !this.store.exists(id)) return null;
    const path = this.store.logPath(id);
    let text: string;
    let truncated = false;
    try {
      const size = statSync(path).size;
      const length = Math.min(size, MAX_LOG_BYTES);
      truncated = size > length;
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, length, size - length);
      } finally {
        closeSync(fd);
      }
      text = buffer.toString('utf8');
    } catch {
      text = '';
    }
    let lines = this.sanitize(text).split('\n');
    if (truncated) lines = lines.slice(1);
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > MAX_LOG_LINES) {
      lines = lines.slice(-MAX_LOG_LINES);
      truncated = true;
    }
    return { operationId: id, lines: lines.map((line) => line.slice(0, 2000)), truncated };
  }
}
