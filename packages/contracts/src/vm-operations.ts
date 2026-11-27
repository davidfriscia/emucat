import { z } from 'zod';
import {
  isRegistrationTerminal,
  registrationOperationSchema,
  type RegistrationOperation,
} from './registration.js';
import { timestampSchema } from './version.js';

/**
 * The background operations that concern one VM's versions, as its management pages follow them (decision 0060).
 *
 * Nothing here is a new operation model: every entry is a `registration_operations` row, the durable record that
 * snapshots, remasters and clones already are (decisions 0015, 0037, 0048, 0052 and 0055), with the state the agent
 * or the server last reported and that the server persisted. This module only says which rows concern a VM, and
 * names their states for people.
 */

/**
 * How an operation concerns the VM it is listed for:
 * - `this_vm`: it makes a new version of this VM (a snapshot, from a local copy or a Remote Snapshot working copy,
 *   or a remaster).
 * - `clone_source`: it copies one of this VM's versions into another, new VM. `operation.vmName` is then the
 *   destination, and `operation.cloneSource` the version copied.
 */
export const VM_OPERATION_RELATIONS = ['this_vm', 'clone_source'] as const;
export type VmOperationRelation = (typeof VM_OPERATION_RELATIONS)[number];

/** The modes listed for `this_vm`. A first registration, an import or a clone made this VM, and is not listed. */
export const VM_OPERATION_OWN_MODES = ['snapshot', 'remaster'] as const;

/**
 * How the archive bytes travel, as far as the server knows. `server`: the server does the work over its own
 * repository connection. `sftp` or `relay`: how the agent reached this repository in its most recent health check,
 * which is not recorded per operation; the interface says so. `null`: not known (an agent that never said).
 */
export const vmOperationTransportSchema = z.enum(['server', 'sftp', 'relay']).nullable();

export const vmOperationSchema = z.object({
  relation: z.enum(VM_OPERATION_RELATIONS),
  operation: registrationOperationSchema,
  transport: vmOperationTransportSchema.default(null),
});
export type VmOperation = z.infer<typeof vmOperationSchema>;

/** How long an ended operation stays listed, unless it still needs attention (an unacknowledged partial success). */
export const VM_OPERATION_RETENTION_HOURS = 24;
/** At most this many operations are listed, newest first. Active ones are never crowded out by ended ones. */
export const VM_OPERATION_LIST_LIMIT = 50;

export const vmOperationListResponseSchema = z.object({
  /** Active operations first, then ended ones; each group newest first. */
  operations: z.array(vmOperationSchema),
  retentionHours: z.number().int().positive(),
  /** The server's clock when it answered, so that elapsed times do not depend on the browser's clock. */
  serverTime: timestampSchema,
});
export type VmOperationListResponse = z.infer<typeof vmOperationListResponseSchema>;

/**
 * The normalized phases an operation can be shown in. Each one is a state the server actually records; none is
 * inferred from time. `waiting_agent` is `queued` (or any active state) while the agent doing the work is offline.
 */
export const VM_OPERATION_PHASES = [
  'queued',
  'waiting_agent',
  'preparing',
  'packaging',
  'transferring',
  'verifying',
  'publishing',
  'finalizing',
  'completed',
  'completed_with_problem',
  'failed',
  'cancelled',
] as const;
export type VmOperationPhase = (typeof VM_OPERATION_PHASES)[number];

/** What a person calls the operation. A Remote Snapshot's publication is a snapshot of a working copy. */
export type VmOperationKind = 'snapshot' | 'remote_snapshot' | 'remaster' | 'clone';

export function vmOperationKind(
  operation: Pick<RegistrationOperation, 'mode' | 'workspaceId'>,
): VmOperationKind {
  if (operation.mode === 'clone') return 'clone';
  if (operation.mode === 'remaster') return 'remaster';
  return operation.workspaceId ? 'remote_snapshot' : 'snapshot';
}

/** Whether the operation is still running (or waiting to), by its recorded state only. */
export function isVmOperationActive(operation: Pick<RegistrationOperation, 'state'>): boolean {
  return !isRegistrationTerminal(operation.state);
}

/**
 * The phase of an operation, from its recorded state. An agent's operation whose agent is offline is waiting for
 * it: it neither failed nor finished, and resumes or ends when the agent reconnects (decision 0015). Work the server
 * does itself never waits for an agent.
 */
export function vmOperationPhase(
  operation: Pick<RegistrationOperation, 'state' | 'performedBy' | 'agentOnline'>,
): VmOperationPhase {
  const offline = operation.performedBy === 'agent' && !operation.agentOnline;
  switch (operation.state) {
    case 'queued':
      return offline ? 'waiting_agent' : 'queued';
    case 'succeeded':
      return 'completed';
    case 'partial_success':
      return 'completed_with_problem';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      break;
  }
  if (offline) return 'waiting_agent';
  switch (operation.state) {
    case 'validating':
      return 'preparing';
    case 'archiving':
      return 'packaging';
    case 'uploading':
      return 'transferring';
    case 'verifying':
      return 'verifying';
    case 'committing':
      return 'publishing';
    default:
      return 'finalizing';
  }
}

/**
 * The progress of the current phase, as a whole percentage, only when the server holds a byte count for it and the
 * phase is not over. A phase whose bytes are all done shows no percentage: what follows (verification, publication,
 * registration) is not measured, and 100% would read as finished. Never derived from elapsed time.
 */
export function vmOperationPercent(
  operation: Pick<RegistrationOperation, 'state' | 'progress'>,
): number | null {
  if (isRegistrationTerminal(operation.state)) return null;
  if (!['archiving', 'uploading', 'verifying'].includes(operation.state)) return null;
  const { doneBytes, totalBytes } = operation.progress;
  if (doneBytes === null || totalBytes === null || totalBytes <= 0) return null;
  if (doneBytes >= totalBytes) return null;
  return Math.min(99, Math.max(0, Math.floor((100 * doneBytes) / totalBytes)));
}

/**
 * The version of this VM an operation is drawn on: a snapshot's parent, or the version a clone copies. A remaster
 * has no single source version, and is shown for the whole history only.
 */
export function vmOperationSourceVersionId(
  entry: Pick<VmOperation, 'relation' | 'operation'>,
): string | null {
  if (entry.relation === 'clone_source') return entry.operation.cloneSource?.versionId ?? null;
  return entry.operation.mode === 'snapshot' ? entry.operation.parentVersionId : null;
}
