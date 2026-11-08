import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Durable update operations. Two files per operation, in the state directory:
 *
 * - `<id>.events`: appended by `emucatctl` as it works, one tab-separated line per fact. It is the
 *   source of truth for progress, and is written whoever started the update (this service or the CLI).
 * - `<id>.json`: written by this service. It records who asked and the process ID, and finally the
 *   verified outcome. Writes are atomic (temporary file, fsync, rename).
 *
 * Nothing lives only in memory, so a restart of this service, of the API, or of the browser loses
 * nothing: every read derives the operation again from these files.
 */

export const STAGES = [
  'queued',
  'checking_repository',
  'fetching_source',
  'building',
  'testing',
  'backing_up_database',
  'applying_migrations',
  'starting_services',
  'health_checking',
  'completed',
  'failed',
] as const;
export type Stage = (typeof STAGES)[number];

export type RollbackOutcome = 'not_needed' | 'restored_previous' | 'unsafe' | 'failed';

export interface OperationRecord {
  id: string;
  requestedBy: string;
  requestedAt: string;
  pid: number | null;
  /** Set once, when this service has decided the outcome. */
  final: {
    status: 'succeeded' | 'failed';
    finishedAt: string;
    error: { code: string; message: string } | null;
  } | null;
}

export interface UpdateEvent {
  at: string;
  key: string;
  value: string;
  message: string;
}

export interface UpdateOperation {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  stage: Stage;
  stages: { stage: Stage; startedAt: string; message: string | null }[];
  fromCommit: string | null;
  targetCommit: string | null;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string | null;
  outcome: 'updated' | 'up_to_date' | null;
  error: { code: string; message: string } | null;
  rollback: RollbackOutcome | null;
  backup: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ROLLBACKS = new Set<string>(['not_needed', 'restored_previous', 'unsafe', 'failed']);

export function isOperationId(value: string): boolean {
  return UUID.test(value);
}

export function parseEvents(text: string): UpdateEvent[] {
  const events: UpdateEvent[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [at = '', key = '', value = '', ...rest] = line.split('\t');
    if (!at || !key) continue;
    events.push({ at, key, value, message: rest.join(' ').slice(0, 500) });
  }
  return events;
}

const clip = (text: string, length: number) =>
  text.length > length ? text.slice(0, length) : text;

/**
 * What an operation is, from its files. `alive` says whether the process running it still exists; an
 * operation with no final result and no live process was interrupted.
 */
export function deriveOperation(
  id: string,
  record: OperationRecord | null,
  events: UpdateEvent[],
  alive: boolean,
): UpdateOperation {
  const operation: UpdateOperation = {
    id,
    status: 'running',
    stage: 'queued',
    stages: [],
    fromCommit: null,
    targetCommit: null,
    requestedBy: record?.requestedBy ?? 'unknown',
    requestedAt: record?.requestedAt ?? events[0]?.at ?? new Date(0).toISOString(),
    finishedAt: null,
    outcome: null,
    error: null,
    rollback: null,
    backup: null,
  };
  let done: UpdateEvent | null = null;
  for (const event of events) {
    switch (event.key) {
      case 'requested':
        if (!record) operation.requestedBy = clip(event.value, 64);
        break;
      case 'from':
        operation.fromCommit = COMMIT.test(event.value) ? event.value : null;
        break;
      case 'target':
        operation.targetCommit = COMMIT.test(event.value) ? event.value : null;
        break;
      case 'stage':
        if ((STAGES as readonly string[]).includes(event.value)) {
          operation.stage = event.value as Stage;
          operation.stages.push({
            stage: event.value as Stage,
            startedAt: event.at,
            message: event.message || null,
          });
        }
        break;
      case 'backup':
        operation.backup = clip(event.value, 255);
        break;
      case 'rollback':
        if (ROLLBACKS.has(event.value)) operation.rollback = event.value as RollbackOutcome;
        break;
      case 'outcome':
        if (event.value === 'updated' || event.value === 'up_to_date') {
          operation.outcome = event.value;
        }
        break;
      case 'error':
        operation.error = { code: clip(event.value, 64), message: clip(event.message, 1000) };
        break;
      case 'done':
        done = event;
        break;
    }
  }

  if (record?.final) {
    operation.status = record.final.status;
    operation.finishedAt = record.final.finishedAt;
    if (record.final.error) operation.error = record.final.error;
  } else if (done && !record) {
    // Started from the command line: the script's own result is all there is.
    operation.status = done.value === 'succeeded' ? 'succeeded' : 'failed';
    operation.finishedAt = done.at;
  } else if (done) {
    // Finished, but not yet verified by this service. Still running from the browser's point of view.
    operation.status = 'running';
  } else if (!alive) {
    operation.status = 'failed';
    operation.finishedAt = events.at(-1)?.at ?? operation.requestedAt;
    operation.error = interruptedError(operation.stage);
  }

  if (operation.status === 'failed') {
    if (operation.stage !== 'failed') {
      operation.stages.push({
        stage: 'failed',
        startedAt: operation.finishedAt ?? new Date().toISOString(),
        message: operation.error?.message ?? null,
      });
      operation.stage = 'failed';
    }
    operation.rollback ??= operation.stages.some((s) => s.stage === 'applying_migrations')
      ? 'unsafe'
      : 'not_needed';
  }
  return operation;
}

export function interruptedError(stage: Stage): { code: string; message: string } {
  const migrated = ['applying_migrations', 'starting_services', 'health_checking'].includes(stage);
  return {
    code: 'interrupted',
    message: migrated
      ? `The update stopped unexpectedly while ${stage.replaceAll('_', ' ')}. Database migrations ` +
        'may have been applied. Run `emucatctl status` on the server before trying again.'
      : `The update stopped unexpectedly while ${stage.replaceAll('_', ' ')}. Nothing was changed ` +
        'in the database; the previous release is still deployed. You can try again.',
  };
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'w', 0o640);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class OperationStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o750 });
  }

  eventsPath(id: string): string {
    return join(this.directory, `${id}.events`);
  }

  recordPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  logPath(id: string): string {
    return join(this.directory, `${id}.log`);
  }

  exists(id: string): boolean {
    return existsSync(this.eventsPath(id)) || existsSync(this.recordPath(id));
  }

  record(id: string): OperationRecord | null {
    return readJson<OperationRecord>(this.recordPath(id));
  }

  saveRecord(record: OperationRecord): void {
    writeJsonAtomic(this.recordPath(record.id), record);
  }

  events(id: string): UpdateEvent[] {
    try {
      return parseEvents(readFileSync(this.eventsPath(id), 'utf8'));
    } catch {
      return [];
    }
  }

  /** Every operation ID, from this service or from the command line. */
  ids(): string[] {
    const ids = new Set<string>();
    for (const file of readdirSync(this.directory)) {
      const match = /^(.+)\.(events|json)$/.exec(file);
      if (match && isOperationId(match[1] as string)) ids.add(match[1] as string);
    }
    return [...ids];
  }
}
