import {
  adminVmRoute,
  isRegistrationCommitted,
  isRetryableCleanup,
  isRegistrationTerminal,
  registrationNeedsAttention,
  registrationVersionKind,
  type LocalCopyStatus,
  type RegistrationMode,
  type RegistrationOperation,
  type RegistrationState,
  type RepositorySummary,
} from '@emucat/contracts';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  acknowledgeRegistration,
  cancelRegistration,
  reconcileRegistration,
  retryRegistrationCleanup,
  startRegistration,
} from '../api';
import { formatBytes, formatTime } from './Agents';
import { InfoDialog } from './Dialogs';
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

/** What a state means for this operation: a snapshot is created, a master is registered. */
export function registrationStateText(operation: Pick<RegistrationOperation, 'mode' | 'state'>) {
  if (operation.mode === 'snapshot' && operation.state === 'succeeded') return 'Snapshot created';
  return STATE_TEXT[operation.state];
}

export const REGISTRATION_MODE_TEXT: Record<RegistrationMode, string> = {
  copy: 'Copy',
  transfer: 'Transfer',
  snapshot: 'Snapshot',
};

/** How a version reads to a person: the master, or the snapshot's own name. */
export function registrationVersionLabel(
  operation: Pick<RegistrationOperation, 'mode' | 'snapshotName'>,
): string {
  return registrationVersionKind(operation.mode) === 'master'
    ? 'Master'
    : (operation.snapshotName ?? 'Snapshot');
}

const LOCAL_COPY_TEXT: Record<LocalCopyStatus, string> = {
  preserved: 'Kept on the agent, unchanged',
  removed: 'Removed from the agent',
  cleanup_failed: 'Kept on the agent: it could not be safely removed',
  unknown: 'Unknown: the agent did not say',
};

export function stateBadge(state: RegistrationState): string {
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

/**
 * The version an operation created, linked to its place in the VM's version history while it exists. A
 * version deleted since by storage cleanup is history, not an error: it is said so, and not linked.
 */
function VersionReference({ operation }: { operation: RegistrationOperation }) {
  const deletion = operation.versionDeletion;
  return (
    <>
      {deletion ? (
        <span className="text-break">{operation.versionId}</span>
      ) : (
        <Link
          className="text-break"
          to={`${adminVmRoute(operation)}#version-${operation.versionId}`}
        >
          {operation.versionId}
        </Link>
      )}{' '}
      {deletion === 'deleted' ? (
        <span className="badge text-bg-secondary">Deleted since</span>
      ) : deletion === 'deleting' ? (
        <span className="badge text-bg-warning">Being deleted</span>
      ) : null}
    </>
  );
}

function Completion({ operation }: { operation: RegistrationOperation }) {
  const { archive } = operation;
  const snapshot = registrationVersionKind(operation.mode) === 'snapshot';
  return (
    <dl className="settings-facts small mb-2">
      <dt>{snapshot ? 'VM' : 'Registered VM'}</dt>
      <dd>
        <Link to={adminVmRoute(operation)}>{operation.vmName}</Link>{' '}
        {snapshot ? null : <span className="badge text-bg-dark border">Private</span>}
      </dd>
      {snapshot ? (
        <>
          <dt>Snapshot</dt>
          <dd className="text-break">{operation.snapshotName ?? 'Unnamed'}</dd>
          <dt>Snapshot version</dt>
          <dd>
            <VersionReference operation={operation} />
          </dd>
          {operation.parentVersionId ? (
            <>
              <dt>Parent version</dt>
              <dd className="text-break">
                {operation.parentSnapshotName ?? 'Master'}{' '}
                <span className="text-body-secondary">({operation.parentVersionId})</span>
              </dd>
            </>
          ) : null}
        </>
      ) : (
        <>
          <dt>Master version</dt>
          <dd>
            <VersionReference operation={operation} />
          </dd>
        </>
      )}
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
            {registrationStateText(operation)}
          </span>
          <span className="badge text-bg-dark border">
            {EMULATOR_NAMES[operation.emulatorType]}
          </span>
          <span className="badge text-bg-dark border">
            {REGISTRATION_MODE_TEXT[operation.mode]}
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
            No {registrationVersionKind(operation.mode)} was created
            {operation.localCopy === 'preserved' ? ', and the local VM is unchanged' : ''}.
          </p>
        ) : null}
        {operation.state === 'partial_success' ? (
          operation.acknowledgedAt ? (
            <p className="small text-body-secondary mb-2">
              Acknowledged {formatTime(operation.acknowledgedAt)}
              {operation.acknowledgedByDisplayName
                ? ` by ${operation.acknowledgedByDisplayName}`
                : ''}
              . Nothing more is expected from EmuCat.
            </p>
          ) : (
            <p className="small text-body-secondary mb-2">
              Once you have dealt with this yourself, acknowledge it to move it to the history.
            </p>
          )
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
          {operation.state === 'partial_success' && isRetryableCleanup(operation.error?.code) ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button"
              disabled={busy || !operation.agentOnline}
              onClick={() => void act(retryRegistrationCleanup)}
            >
              Retry removal
            </button>
          ) : null}
          {operation.state === 'partial_success' && !operation.acknowledgedAt ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button"
              disabled={busy}
              onClick={() => void act(acknowledgeRegistration)}
            >
              Acknowledge
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

/**
 * Ended operations as one compact row each, newest first. Each opens the full card in a dialog: the
 * error, what to do about it, and any action still possible.
 */
export function RegistrationHistoryTable({
  operations,
  showAgent = false,
  caption,
  onChanged,
}: {
  operations: RegistrationOperation[];
  showAgent?: boolean;
  caption: string;
  onChanged: () => void;
}) {
  const [details, setDetails] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const shown = operations.find((operation) => operation.id === details) ?? null;
  const close = () => {
    setDetails(null);
    opener.current?.focus();
  };
  return (
    <>
      <div className="table-responsive">
        <table className="table table-sm small align-middle mb-0 registration-history">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">VM</th>
              {showAgent ? <th scope="col">Agent</th> : null}
              <th scope="col">Mode</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">
                <span className="visually-hidden">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {operations.map((operation) => {
              const committed = isRegistrationCommitted(operation.state);
              return (
                <tr key={operation.id}>
                  <td className="text-nowrap">{formatTime(operation.createdAt)}</td>
                  <td>
                    {committed || operation.mode === 'snapshot' ? (
                      <Link className="vm-identity" to={adminVmRoute(operation)}>
                        {operation.vmName}
                      </Link>
                    ) : (
                      <span className="vm-identity">{operation.vmName}</span>
                    )}{' '}
                    <span className="badge text-bg-dark border">
                      {EMULATOR_NAMES[operation.emulatorType]}
                    </span>
                  </td>
                  {showAgent ? <td>{operation.agentName}</td> : null}
                  <td>{REGISTRATION_MODE_TEXT[operation.mode]}</td>
                  <td>
                    <span className={`badge ${stateBadge(operation.state)}`}>
                      {registrationStateText(operation)}
                    </span>
                    {registrationNeedsAttention(operation) &&
                    isRegistrationTerminal(operation.state) ? (
                      <span className="badge text-bg-warning ms-1">Needs attention</span>
                    ) : null}
                  </td>
                  <td>
                    {committed ? (
                      <>
                        {registrationVersionLabel(operation)}
                        {operation.versionDeletion ? (
                          <span className="badge text-bg-secondary ms-1">
                            {operation.versionDeletion === 'deleted'
                              ? 'Deleted since'
                              : 'Being deleted'}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-body-secondary">None</span>
                    )}
                  </td>
                  <td className="text-end">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary theme-button"
                      aria-label={`Details of the ${REGISTRATION_MODE_TEXT[operation.mode].toLowerCase()} of ${operation.vmName}, ${formatTime(operation.createdAt)}`}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setDetails(operation.id);
                      }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown ? (
        <InfoDialog title="Registration details" onClose={close}>
          <RegistrationCard operation={shown} onChanged={onChanged} />
        </InfoDialog>
      ) : null}
    </>
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
  mode: Exclude<RegistrationMode, 'snapshot'>;
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
