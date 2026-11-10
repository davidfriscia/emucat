import {
  isRegistrationTerminal,
  registrationRecovery,
  type RegistrationOperation,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useState } from 'react';
import { createSnapshot, fetchRegistration } from '../api';
import { usePolledData } from '../usePolledData';
import { ConfirmDialog } from './Dialogs';

const ACTIVE_POLL_MS = 1_500;

/** How a version is named for people: the master, or a snapshot's label. */
export function versionLabel(version: {
  kind: 'master' | 'snapshot';
  snapshotName: string | null;
}): string {
  return version.kind === 'master' ? 'Master' : (version.snapshotName ?? 'Snapshot');
}

export const shortId = (id: string) => id.slice(0, 8);

export const SNAPSHOT_STATE_TEXT: Partial<Record<RegistrationOperation['state'], string>> = {
  queued: 'Waiting for the agent',
  validating: 'Checking the copy',
  archiving: 'Archiving',
  uploading: 'Uploading to the repository',
  verifying: 'Verifying the uploaded archive',
  committing: 'Recording the snapshot',
  cleaning_local: 'Finishing',
  succeeded: 'Snapshot created',
  failed: 'Failed',
  cancelled: 'Cancelled',
  partial_success: 'Created, with a problem',
};

/** The snapshot being created, followed until it ends. */
export function SnapshotProgress({
  operationId,
  onFinished,
}: {
  operationId: string;
  onFinished: () => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => fetchRegistration(operationId, signal),
    [operationId],
  );
  const [done, setDone] = useState(false);
  const { data } = usePolledData(load, done ? null : ACTIVE_POLL_MS);
  if (data && isRegistrationTerminal(data.state) && !done) {
    setDone(true);
    onFinished();
  }
  if (!data) return null;
  const percent =
    data.progress.doneBytes !== null && data.progress.totalBytes
      ? Math.round((100 * data.progress.doneBytes) / data.progress.totalBytes)
      : null;
  const failed = data.state === 'failed' || data.state === 'cancelled';
  return (
    <div
      className={`alert ${failed ? 'alert-danger' : data.state === 'succeeded' ? 'alert-success' : 'alert-info'} small`}
      role="status"
      aria-live="polite"
    >
      <strong>{data.snapshotName ?? 'Snapshot'}</strong>:{' '}
      {SNAPSHOT_STATE_TEXT[data.state] ?? data.state}
      {percent !== null && !isRegistrationTerminal(data.state) ? ` (${percent}%)` : null}
      {data.error ? (
        <div className="mt-1">
          {data.error.message}
          {registrationRecovery(data.error.code) ? (
            <div className="text-body-secondary">{registrationRecovery(data.error.code)}</div>
          ) : null}
        </div>
      ) : null}
      {data.state === 'succeeded' ? (
        <div className="mt-1">
          A new immutable version, <span className="vm-identity">{shortId(data.versionId)}</span>,
          is a child of <span className="vm-identity">{shortId(data.parentVersionId ?? '')}</span>.
        </div>
      ) : null}
    </div>
  );
}

/** What a snapshot of an agent's persistent copy needs: whose copy, and the version it came from. */
export interface SnapshotRequest {
  agentId: string;
  agentName: string;
  parentVersionId: string;
  parentLabel: string;
}

/** Confirms a snapshot of an agent's persistent local copy. One request ID per dialog. */
export function CreateSnapshotDialog({
  vm,
  request,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  request: SnapshotRequest;
  onClose: () => void;
  onStarted: (operation: RegistrationOperation) => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  return (
    <ConfirmDialog
      title={`Create a snapshot from ${request.agentName}`}
      action="Create snapshot"
      onClose={onClose}
      onConfirm={async () => {
        const operation = await createSnapshot(vm, {
          agentId: request.agentId,
          parentVersionId: request.parentVersionId,
          requestId,
        });
        onStarted(operation);
      }}
    >
      <p>
        The agent archives its local copy of {vm.vmName} as a new, immutable snapshot whose parent
        is <strong>{request.parentLabel}</strong>, the version that copy came from. The archive is
        uploaded and verified in the repository before anything is recorded, and no existing version
        is changed. The local copy is read, never removed.
      </p>
      <p className="mb-0">The VM must not be running on that agent.</p>
    </ConfirmDialog>
  );
}
