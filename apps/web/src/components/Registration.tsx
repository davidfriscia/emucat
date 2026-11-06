import {
  isRegistrationCommitted,
  isRegistrationTerminal,
  type LocalCopyStatus,
  type RegistrationMode,
  type RegistrationOperation,
  type RegistrationState,
  type RepositorySummary,
} from '@emucat/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  cancelRegistration,
  reconcileRegistration,
  retryRegistrationCleanup,
  startRegistration,
} from '../api';
import { formatBytes, formatTime } from './Agents';
import { FormError } from './States';

const EMULATOR_NAMES = { '86box': '86Box', qemu: 'QEMU' } as const;

const STATE_TEXT: Record<RegistrationState, string> = {
  queued: 'Waiting for the agent',
  validating: 'Checking the VM',
  archiving: 'Building the archive',
  uploading: 'Uploading to the repository',
  verifying: 'Verifying the stored archive',
  committing: 'Recording the master',
  cleaning_local: 'Finishing up on the agent',
  succeeded: 'Registered',
  failed: 'Failed',
  cancelled: 'Cancelled',
  partial_success: 'Registered, with a problem',
};

const LOCAL_COPY_TEXT: Record<LocalCopyStatus, string> = {
  preserved: 'Kept on the agent, unchanged',
  removed: 'Removed from the agent',
  cleanup_failed: 'Kept on the agent: it could not be safely removed',
  unknown: 'Unknown: the agent did not say',
};

function stateBadge(state: RegistrationState): string {
  switch (state) {
    case 'succeeded':
      return 'text-bg-success';
    case 'failed':
      return 'text-bg-danger';
    case 'partial_success':
      return 'text-bg-warning';
    case 'cancelled':
      return 'text-bg-secondary';
    default:
      return 'text-bg-primary';
  }
}

/** Only what the agent measured: with no known total, there is no percentage. */
function RegistrationProgress({ operation }: { operation: RegistrationOperation }) {
  const { doneBytes, totalBytes } = operation.progress;
  const known = doneBytes !== null && totalBytes !== null && totalBytes > 0;
  const percent = known ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : null;
  return (
    <div className="mb-2">
      <div className="small mb-1">
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        {STATE_TEXT[operation.state]}
        {known ? `: ${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}` : ''}
      </div>
      {percent === null ? null : (
        <div
          className="progress"
          role="progressbar"
          aria-label={STATE_TEXT[operation.state]}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-bar" style={{ width: `${percent}%` }}>
            {percent}%
          </div>
        </div>
      )}
    </div>
  );
}

function Completion({ operation }: { operation: RegistrationOperation }) {
  const { archive } = operation;
  return (
    <dl className="settings-facts small mb-2">
      <dt>Registered VM</dt>
      <dd>
        <Link
          to={`/admin/vms/${encodeURIComponent(operation.emulatorType)}/${encodeURIComponent(operation.vmName)}`}
        >
          {operation.vmName}
        </Link>{' '}
        <span className="badge text-bg-dark border">Private</span>
      </dd>
      <dt>Master version</dt>
      <dd className="text-break">{operation.versionId}</dd>
      <dt>Repository</dt>
      <dd>{operation.repositoryName}</dd>
      {archive ? (
        <>
          <dt>Archive size</dt>
          <dd>
            {formatBytes(archive.sizeBytes)}, from {archive.fileCount} files and{' '}
            {formatBytes(archive.totalUncompressedBytes)}
          </dd>
          <dt>Integrity</dt>
          <dd>
            SHA-256 verified by the agent, by reading the stored bytes back.
            <br />
            <code className="text-break">{archive.sha256}</code>
          </dd>
        </>
      ) : null}
      <dt>Local copy</dt>
      <dd>{operation.localCopy ? LOCAL_COPY_TEXT[operation.localCopy] : 'Being finished'}</dd>
    </dl>
  );
}

export function RegistrationCard({
  operation,
  onChanged,
}: {
  operation: RegistrationOperation;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const terminal = isRegistrationTerminal(operation.state);
  const committed = isRegistrationCommitted(operation.state);

  const act = async (action: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action(operation.id);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <div className="card-body">
        <h3 className="h6 card-title media-filename">{operation.vmName}</h3>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <span className={`badge ${stateBadge(operation.state)}`}>
            {STATE_TEXT[operation.state]}
          </span>
          <span className="badge text-bg-dark border">
            {EMULATOR_NAMES[operation.emulatorType]}
          </span>
          <span className="badge text-bg-dark border">
            {operation.mode === 'transfer' ? 'Transfer' : 'Copy'}
          </span>
        </div>
        {terminal ? null : <RegistrationProgress operation={operation} />}
        {!terminal && !operation.agentOnline ? (
          <div className="alert alert-warning small mb-2" role="status">
            The agent is offline. This continues when it reconnects. Nothing is lost in the
            meantime.
          </div>
        ) : null}
        {operation.state === 'committing' ? (
          <p className="small text-body-secondary mb-2">
            The agent has verified the archive in the repository. The agent repeats its report until
            the server has recorded it.
          </p>
        ) : null}
        {operation.cancelRequested && !terminal ? (
          <p className="small text-body-secondary mb-2">Cancellation requested.</p>
        ) : null}
        {operation.error ? (
          <div
            className={`alert small mb-2 ${
              operation.state === 'partial_success' || operation.state === 'cancelled'
                ? 'alert-warning'
                : 'alert-danger'
            }`}
            role="alert"
          >
            {operation.error.message}
            {operation.recovery ? <div className="mt-1">{operation.recovery}</div> : null}
          </div>
        ) : null}
        {committed ? <Completion operation={operation} /> : null}
        {operation.state === 'failed' || operation.state === 'cancelled' ? (
          <p className="small text-body-secondary mb-2">
            No master was created
            {operation.localCopy === 'preserved' ? ', and the local VM is unchanged' : ''}.
          </p>
        ) : null}
        <p className="small text-body-secondary mb-2">
          Started {formatTime(operation.createdAt)}
          {operation.requestedByDisplayName ? ` by ${operation.requestedByDisplayName}` : ''}.
        </p>
        <FormError error={error} />
        <div className="d-flex flex-wrap gap-2">
          {!terminal && !committed ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={busy}
              onClick={() => void act(cancelRegistration)}
            >
              Cancel
            </button>
          ) : null}
          {operation.state === 'partial_success' &&
          operation.error?.code === 'transfer_blocked_media' ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button"
              disabled={busy || !operation.agentOnline}
              onClick={() => void act(retryRegistrationCleanup)}
            >
              Retry removal
            </button>
          ) : null}
          {operation.state === 'committing' ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button"
              disabled={busy}
              onClick={() => void act(reconcileRegistration)}
            >
              Retry recording it
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

const COPY_EXPLANATION =
  'The agent builds a standalone archive of this VM, uploads it directly to the repository, and verifies it there. The local VM stays exactly as it is.';
const TRANSFER_EXPLANATION =
  'The same as a copy, and then the agent removes the local VM. Removal only happens after the master is recorded and everything has been checked again.';

export interface RegistrationTarget {
  agentId: string;
  agentName: string;
  emulatorType: 'qemu' | '86box';
  vmName: string;
  discoveryOperationId: string;
}

export function RegistrationDialog({
  target,
  mode,
  repository,
  onClose,
  onStarted,
}: {
  target: RegistrationTarget;
  mode: RegistrationMode;
  repository: RepositorySummary;
  onClose: () => void;
  onStarted: (operation: RegistrationOperation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [understood, setUnderstood] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const isTransfer = mode === 'transfer';

  // Once only: polling re-renders this, and must not take the focus away from the checkbox.
  useEffect(() => {
    cancel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await startRegistration({
          agentId: target.agentId,
          repositoryId: repository.id,
          emulatorType: target.emulatorType,
          vmName: target.vmName,
          mode,
          discoveryOperationId: target.discoveryOperationId,
          ...(isTransfer ? { confirmDestructive: understood } : {}),
        }),
      );
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const title = isTransfer ? 'Transfer to the repository' : 'Copy to the repository';
  return (
    <>
      <div className="modal-backdrop show" />
      <div
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby="registration-title"
        tabIndex={-1}
      >
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title h5" id="registration-title">
                {title}
              </h2>
            </div>
            <div className="modal-body">
              <dl className="settings-facts small">
                <dt>VM</dt>
                <dd className="media-filename">
                  {target.vmName} ({EMULATOR_NAMES[target.emulatorType]})
                </dd>
                <dt>Source agent</dt>
                <dd>{target.agentName}</dd>
                <dt>Repository</dt>
                <dd>
                  {repository.name} ({repository.host}:{repository.port})
                </dd>
              </dl>
              <p>{isTransfer ? TRANSFER_EXPLANATION : COPY_EXPLANATION}</p>
              <p className="small text-body-secondary">
                The archive goes straight from the agent to the repository, and never through this
                server. The new catalog entry is private until you publish it. Stop the VM first: an
                archive of a running VM fails.
              </p>
              {isTransfer ? (
                <div className="alert alert-danger" role="alert">
                  <strong>This deletes the local VM.</strong> It is removed from the agent’s disk
                  once the archive is verified and recorded. The VM’s screenshots are not in the
                  archive, so it is only removed once the server confirms that it holds every one of
                  them. Otherwise it is kept, and the removal can be retried later.
                  <div className="form-check mt-2">
                    <input
                      id="transfer-understood"
                      type="checkbox"
                      className="form-check-input"
                      checked={understood}
                      onChange={(event) => setUnderstood(event.target.checked)}
                    />
                    <label className="form-check-label" htmlFor="transfer-understood">
                      I understand that the local copy of {target.vmName} will be deleted
                    </label>
                  </div>
                </div>
              ) : null}
              <FormError error={error} />
            </div>
            <div className="modal-footer">
              <button
                ref={cancel}
                type="button"
                className="btn btn-outline-secondary theme-button"
                onClick={onClose}
              >
                Keep things as they are
              </button>
              <button
                type="button"
                className={`btn ${isTransfer ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy || (isTransfer && !understood)}
                onClick={() => void start()}
              >
                {isTransfer ? 'Transfer and delete locally' : 'Start the copy'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
