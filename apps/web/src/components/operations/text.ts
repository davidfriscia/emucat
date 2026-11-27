import {
  vmOperationKind,
  vmOperationPercent,
  vmOperationPhase,
  type VmOperation,
  type VmOperationKind,
  type VmOperationPhase,
} from '@emucat/contracts';

/**
 * How an operation is named for people (decision 0060). Every phase is a state the server recorded; the words only
 * say which, for the kind of operation it is.
 */

const RUNNING_TITLE: Record<VmOperationKind, string> = {
  snapshot: 'Creating snapshot',
  remote_snapshot: 'Publishing Remote Snapshot',
  remaster: 'Remastering',
  clone: 'Cloning VM',
};

const ENDED_TITLE: Record<
  VmOperationKind,
  Record<'completed' | 'problem' | 'failed' | 'cancelled', string>
> = {
  snapshot: {
    completed: 'Snapshot created',
    problem: 'Snapshot created, with a problem',
    failed: 'Snapshot failed',
    cancelled: 'Snapshot cancelled',
  },
  remote_snapshot: {
    completed: 'Remote Snapshot published',
    problem: 'Remote Snapshot published, with a problem',
    failed: 'Remote Snapshot publication failed',
    cancelled: 'Remote Snapshot publication cancelled',
  },
  remaster: {
    completed: 'Remaster completed',
    problem: 'Remaster completed, with a problem',
    failed: 'Remaster failed',
    cancelled: 'Remaster cancelled',
  },
  clone: {
    completed: 'VM cloned',
    problem: 'VM cloned, with a problem',
    failed: 'Clone failed',
    cancelled: 'Clone cancelled',
  },
};

export const KIND_TEXT: Record<VmOperationKind, string> = {
  snapshot: 'Snapshot of a local copy',
  remote_snapshot: 'Snapshot of a Remote Snapshot session',
  remaster: 'Remaster from a local copy',
  clone: 'Clone into a new VM',
};

/** What each phase is doing, in general and where a kind of operation does something more particular. */
const PHASE_TEXT: Record<VmOperationPhase, string> = {
  queued: 'Queued',
  waiting_agent: 'Waiting for the agent',
  preparing: 'Checking the copy',
  packaging: 'Packaging',
  transferring: 'Transferring',
  verifying: 'Verifying',
  publishing: 'Publishing',
  finalizing: 'Finalizing',
  completed: 'Completed',
  completed_with_problem: 'Completed, with a problem',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const CLONE_PHASE_TEXT: Partial<Record<VmOperationPhase, string>> = {
  queued: 'Queued on the server',
  preparing: 'Checking the source',
  packaging: 'Copying the source archive',
  transferring: 'Writing the new archive',
  verifying: 'Verifying the new archive',
  publishing: 'Registering the new VM',
};

export function operationPhase(entry: VmOperation): VmOperationPhase {
  return vmOperationPhase(entry.operation);
}

export function phaseText(entry: VmOperation): string {
  const phase = operationPhase(entry);
  const kind = vmOperationKind(entry.operation);
  return (kind === 'clone' ? CLONE_PHASE_TEXT[phase] : undefined) ?? PHASE_TEXT[phase];
}

/** The operation's name: what it is doing while it runs, how it ended once it has. */
export function operationTitle(entry: VmOperation): string {
  const kind = vmOperationKind(entry.operation);
  switch (operationPhase(entry)) {
    case 'completed':
      return ENDED_TITLE[kind].completed;
    case 'completed_with_problem':
      return ENDED_TITLE[kind].problem;
    case 'failed':
      return ENDED_TITLE[kind].failed;
    case 'cancelled':
      return ENDED_TITLE[kind].cancelled;
    default:
      return RUNNING_TITLE[kind];
  }
}

/** The short status, as the indicator shows it: the phase, and a measured percentage when there is one. */
export function statusText(entry: VmOperation): string {
  // Bytes counted before the agent went away say nothing about now.
  const percent =
    operationPhase(entry) === 'waiting_agent' ? null : vmOperationPercent(entry.operation);
  return percent === null ? phaseText(entry) : `${phaseText(entry)} ${percent}%`;
}

/** One sentence for the announcement of an ending, and for a notice. */
export function operationOutcomeText(entry: VmOperation): string {
  const { operation } = entry;
  const title = operationTitle(entry);
  if (operation.mode === 'clone') return `${title}: ${operation.vmName}`;
  return operation.snapshotName ? `${title}: ${operation.snapshotName}` : title;
}

export type OperationTone = 'info' | 'success' | 'warning' | 'danger';

export function operationTone(entry: VmOperation): OperationTone {
  switch (operationPhase(entry)) {
    case 'completed':
      return 'success';
    case 'completed_with_problem':
    case 'waiting_agent':
    case 'cancelled':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'info';
  }
}
