import {
  EMULATOR_LABELS,
  isRestoreCancellable,
  isRestoreTerminal,
  type RegistrationOperation,
  type RestoreAgentOption,
  type RestoreIneligibleReason,
  type RestoreOperation,
  type RestoreOptionsResponse,
  type RestoreState,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { cancelRestore, fetchRestoreOptions, fetchRestores, startRestore } from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { InfoDialog } from './Dialogs';
import { useModalDialog } from './Gallery';
import {
  CreateSnapshotDialog,
  shortId,
  SnapshotProgress,
  versionLabel,
  type SnapshotRequest,
} from './Snapshots';
import { FormError } from './States';

export { versionLabel } from './Snapshots';

const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;
/** How many finished restores the history shows. Every row is kept by the server. */
const HISTORY_ROWS = 20;

const STATE_TEXT: Record<RestoreState, string> = {
  queued: 'Waiting for the agent',
  validating: 'Validating',
  downloading: 'Downloading from the repository',
  verifying: 'Verifying the archive',
  extracting: 'Extracting and verifying files',
  publishing_local: 'Moving the VM into place',
  committing: 'Recording the local copy',
  succeeded: 'Restored',
  failed: 'Failed',
  cancelled: 'Cancelled',
  partial_success: 'Restored, with a problem',
};

const STAGE_ORDER: readonly RestoreState[] = [
  'validating',
  'downloading',
  'verifying',
  'extracting',
  'publishing_local',
  'committing',
];

const INELIGIBLE_TEXT: Record<RestoreIneligibleReason, string> = {
  agent_revoked: 'revoked',
  agent_offline: 'offline',
  agent_cannot_restore: 'its version cannot restore VMs',
  emulator_not_configured: 'no base path for this emulator',
  repository_not_authorized: 'not associated with this repository',
  repository_not_configured: 'no local settings for this repository',
  local_copy_exists: 'it already holds a copy',
  no_local_copy: 'it holds no copy to replace',
  vm_running: 'the VM is running there',
  operation_in_progress: 'busy with another operation',
};

export function restoreStateText(state: RestoreState): string {
  return STATE_TEXT[state];
}

function stateBadge(state: RestoreState): string {
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
function RestoreProgress({ operation }: { operation: RestoreOperation }) {
  const { doneBytes, totalBytes } = operation.progress;
  const current = STAGE_ORDER.indexOf(operation.state);
  return (
    <>
      <ol className="restore-stages small" aria-label="Stages of this restore">
        {STAGE_ORDER.map((stage, index) => (
          <li
            key={stage}
            className={
              index < current ? 'text-body-secondary' : index === current ? 'fw-semibold' : ''
            }
            aria-current={index === current ? 'step' : undefined}
          >
            {index < current ? '✓ ' : ''}
            {STATE_TEXT[stage]}
          </li>
        ))}
      </ol>
      {doneBytes !== null && totalBytes !== null && totalBytes > 0 ? (
        <div className="mb-2">
          <progress
            className="w-100"
            value={doneBytes}
            max={totalBytes}
            aria-label={STATE_TEXT[operation.state]}
          />
          <div className="small text-body-secondary">
            {formatBytes(doneBytes)} of {formatBytes(totalBytes)}
          </div>
        </div>
      ) : null}
    </>
  );
}

function cacheText(cache: RestoreOperation['cache']): string | null {
  if (cache.hit === true)
    return 'Used a verified copy from the agent’s cache. Nothing was downloaded.';
  if (cache.hit === false) {
    return cache.downloadedBytes !== null
      ? `Not in the agent’s cache. Downloaded ${formatBytes(cache.downloadedBytes)}.`
      : 'Not in the agent’s cache, so it is being downloaded.';
  }
  return null;
}

/** Names versions for people, when the page knows them; otherwise a short identifier. */
export type VersionNamer = (versionId: string | null) => string;

const shortNamer: VersionNamer = (versionId) => (versionId ? shortId(versionId) : 'Unknown');

export function versionNamer(options: RestoreOptionsResponse | null | undefined): VersionNamer {
  const versions = options?.versions ?? [];
  return (versionId) => {
    if (!versionId) return 'Unknown';
    const version = versions.find((item) => item.versionId === versionId);
    if (version) return versionLabel(version);
    return options?.master?.versionId === versionId ? 'Master' : shortId(versionId);
  };
}

function restoreKind(operation: RestoreOperation): string {
  if (operation.workspaceId) return 'Remote session';
  return operation.replacement ? 'Replacement' : 'Restore';
}

/** One restore, however far along it is. */
export function RestoreCard({
  operation,
  showVm = false,
  onChange,
}: {
  operation: RestoreOperation;
  showVm?: boolean;
  onChange: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const finished = isRestoreTerminal(operation.state);
  const cache = cacheText(operation.cache);

  const cancel = async () => {
    setError(null);
    setBusy(true);
    try {
      await cancelRestore(operation.id);
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="border rounded-2 p-3 mb-2" aria-label={`Restore on ${operation.agentName}`}>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <span className={`badge ${stateBadge(operation.state)}`}>
          {STATE_TEXT[operation.state]}
        </span>
        {operation.replacement ? (
          <span className="badge text-bg-warning">Replaces the local copy</span>
        ) : null}
        <span className="small">
          {showVm ? (
            <>
              <span className="vm-identity">{operation.vmName}</span> on{' '}
            </>
          ) : null}
          {operation.agentName}
        </span>
        {!finished && !operation.agentOnline ? (
          <span className="badge text-bg-secondary">Agent offline</span>
        ) : null}
        <span className="small text-body-secondary ms-auto">{formatTime(operation.createdAt)}</span>
      </div>
      <FormError error={error} />
      {!finished ? <RestoreProgress operation={operation} /> : null}
      <RestoreOutcome operation={operation} cache={cache} />
      {isRestoreCancellable(operation.state) ? (
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          disabled={busy || operation.cancelRequested}
          onClick={() => void cancel()}
        >
          {operation.cancelRequested ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : null}
    </article>
  );
}

/** What a restore did or why it did not: shared by the progress card and the details dialog. */
function RestoreOutcome({
  operation,
  cache,
}: {
  operation: RestoreOperation;
  cache: string | null;
}) {
  const finished = isRestoreTerminal(operation.state);
  return (
    <>
      {cache ? <p className="small mb-2">{cache}</p> : null}
      {operation.error ? (
        <div
          className={`alert ${operation.state === 'cancelled' ? 'alert-secondary' : 'alert-danger'} small`}
          role="alert"
        >
          <strong className="vm-identity">{operation.error.code}</strong>: {operation.error.message}
          {operation.recovery ? <div className="mt-1">{operation.recovery}</div> : null}
        </div>
      ) : null}
      {operation.localDirectory && finished ? (
        <dl className="mb-2 small settings-facts">
          <dt>Local directory</dt>
          <dd className="vm-identity">{operation.localDirectory}</dd>
          <dt>Restored version</dt>
          <dd className="vm-identity">{operation.versionId}</dd>
          {operation.verified ? (
            <>
              <dt>Integrity</dt>
              <dd>
                The archive’s SHA-256, its manifest and {operation.verified.fileCount} files were
                verified by the agent.
              </dd>
              <dt>Manifest SHA-256</dt>
              <dd className="vm-identity">{operation.verified.manifestSha256}</dd>
              <dt>Restored size</dt>
              <dd>{formatBytes(operation.verified.totalUncompressedBytes)}</dd>
            </>
          ) : null}
          {operation.cache.totalBytes !== null ? (
            <>
              <dt>Cache usage</dt>
              <dd>{formatBytes(operation.cache.totalBytes)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {operation.state === 'succeeded' && !operation.workspaceId ? (
        <p className="small text-body-secondary mb-2">
          The VM was not started. Run it yourself when you want to.
        </p>
      ) : null}
    </>
  );
}

/** Everything recorded about one restore. It names identities and hashes, never a credential. */
function RestoreDetails({
  operation,
  nameVersion,
}: {
  operation: RestoreOperation;
  nameVersion: VersionNamer;
}) {
  const cache = cacheText(operation.cache);
  return (
    <>
      <div className="d-flex flex-wrap gap-1 mb-2">
        <span className={`badge ${stateBadge(operation.state)}`}>
          {STATE_TEXT[operation.state]}
        </span>
        <span className="badge text-bg-light border">{restoreKind(operation)}</span>
      </div>
      <dl className="small settings-facts mb-2">
        <dt>VM</dt>
        <dd className="vm-identity">{operation.vmName}</dd>
        <dt>Emulator</dt>
        <dd>{EMULATOR_LABELS[operation.emulatorType]}</dd>
        <dt>Agent</dt>
        <dd>{operation.agentName}</dd>
        <dt>Version</dt>
        <dd>
          {nameVersion(operation.versionId)}{' '}
          <span className="vm-identity">{operation.versionId}</span>
        </dd>
        {operation.replacement ? (
          <>
            <dt>Replaced</dt>
            <dd>
              {operation.replacement.replacedVersionId
                ? `A copy of ${nameVersion(operation.replacement.replacedVersionId)}`
                : 'A copy whose version was not known'}
              {operation.replacement.discardLocalChanges
                ? ', its local changes discarded on request'
                : ', checked to be unchanged first'}
            </dd>
          </>
        ) : null}
        <dt>Repository</dt>
        <dd>{operation.repositoryName}</dd>
        <dt>Archive</dt>
        <dd>
          {formatBytes(operation.archive.sizeBytes)}, SHA-256{' '}
          <span className="vm-identity">{operation.archive.sha256}</span>
        </dd>
        <dt>Requested</dt>
        <dd>
          {formatTime(operation.createdAt)}
          {operation.requestedByDisplayName ? ` by ${operation.requestedByDisplayName}` : ''}
        </dd>
        <dt>Finished</dt>
        <dd>{operation.finishedAt ? formatTime(operation.finishedAt) : 'Not yet'}</dd>
        <dt>Operation</dt>
        <dd className="vm-identity">{operation.id}</dd>
      </dl>
      <RestoreOutcome operation={operation} cache={cache} />
    </>
  );
}

/**
 * Restores as a compact table, newest first, with every detail one click away. Restores still running
 * are shown above it with their progress, because that is when they need attention.
 */
export function RestoreHistory({
  operations,
  showVm = false,
  nameVersion = shortNamer,
  onChange,
}: {
  operations: RestoreOperation[];
  showVm?: boolean;
  nameVersion?: VersionNamer;
  onChange: () => void;
}) {
  const [details, setDetails] = useState<RestoreOperation | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const running = operations.filter((operation) => !isRestoreTerminal(operation.state));
  const rows = operations.slice(0, HISTORY_ROWS);
  const close = () => {
    setDetails(null);
    opener.current?.focus();
  };
  return (
    <>
      {running.map((operation) => (
        <RestoreCard key={operation.id} operation={operation} showVm={showVm} onChange={onChange} />
      ))}
      {rows.length > 0 ? (
        <div className="table-responsive">
          <table className="table table-sm small align-middle mb-0 restore-history">
            <caption className="visually-hidden">Restore history, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">{showVm ? 'VM and agent' : 'Agent'}</th>
                <th scope="col">Version</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((operation) => (
                <tr key={operation.id}>
                  <td className="text-nowrap">{formatTime(operation.createdAt)}</td>
                  <td>
                    {showVm ? (
                      <>
                        <span className="vm-identity">{operation.vmName}</span> on{' '}
                      </>
                    ) : null}
                    {operation.agentName}
                  </td>
                  <td>{nameVersion(operation.versionId)}</td>
                  <td>
                    {operation.replacement ? (
                      <span className="badge text-bg-warning">Replacement</span>
                    ) : (
                      restoreKind(operation)
                    )}
                  </td>
                  <td>
                    <span className={`badge ${stateBadge(operation.state)}`}>
                      {STATE_TEXT[operation.state]}
                    </span>
                  </td>
                  <td className="text-end">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary theme-button"
                      aria-label={`Details of the restore on ${operation.agentName}, ${formatTime(operation.createdAt)}`}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setDetails(operation);
                      }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {operations.length > rows.length ? (
        <p className="small text-body-secondary mt-2 mb-0">
          The {HISTORY_ROWS} most recent of {operations.length} restores.
        </p>
      ) : null}
      {details ? (
        <InfoDialog title="Restore details" onClose={close}>
          <RestoreDetails
            operation={operations.find((item) => item.id === details.id) ?? details}
            nameVersion={nameVersion}
          />
        </InfoDialog>
      ) : null}
    </>
  );
}

function localText(option: RestoreAgentOption): string {
  const { availability, contentStatus, lastVerifiedAt } = option.local;
  if (availability === 'none') return 'No local copy';
  if (availability === 'absent') return 'No longer present on this agent';
  if (contentStatus === 'verified') return `Verified copy, as of ${formatTime(lastVerifiedAt)}`;
  if (contentStatus === 'modified') return 'Has a local copy that differs from its version';
  return 'Has a local copy, not verified since the agent last connected';
}

/** Whether a restore on this agent would replace its persistent copy. */
function replaces(agent: RestoreAgentOption): boolean {
  return agent.local.availability === 'present';
}

/** Whether this agent can take a restore of this VM now, as a new copy or as a replacement. */
function canTake(agent: RestoreAgentOption): boolean {
  return replaces(agent) ? agent.replace.eligible : agent.eligible;
}

function refusal(agent: RestoreAgentOption): RestoreIneligibleReason | null {
  return replaces(agent) ? agent.replace.reason : agent.ineligibleReason;
}

/**
 * The confirmation. It explains what will and will not happen, and offers no way to choose a path. Any
 * version can be restored: the master, or any snapshot in the tree. On an agent that already holds a
 * copy, it is an explicit replacement: what is there now, what replaces it, and a destructive button that
 * says so. Changes known to be in the copy have to be acknowledged before that button is enabled.
 */
export function RestoreDialog({
  vm,
  options,
  initialVersionId,
  onClose,
  onStarted,
  onSnapshotFirst,
}: {
  vm: VmIdentity;
  options: RestoreOptionsResponse;
  initialVersionId?: string | undefined;
  onClose: () => void;
  onStarted: () => void;
  /** Offered when the copy being replaced may hold changes and its version is known. */
  onSnapshotFirst?: ((request: SnapshotRequest) => void) | undefined;
}) {
  const [agentId, setAgentId] = useState(
    (options.agents.find(canTake) ?? options.agents[0])?.agentId ?? '',
  );
  const [versionId, setVersionId] = useState(
    initialVersionId ?? options.master?.versionId ?? options.versions[0]?.versionId ?? '',
  );
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useModalDialog(dialog, select, onClose);

  const versions = options.versions;
  const version =
    versions.find((item) => item.versionId === versionId) ??
    (options.master ? { ...options.master, kind: 'master' as const, snapshotName: null } : null);
  const chosen = options.agents.find((agent) => agent.agentId === agentId);
  if (!version) return null;
  const nameVersion = versionNamer(options);
  const replacing = chosen !== undefined && replaces(chosen);
  const modified = replacing && chosen.local.contentStatus === 'modified';
  const mayHaveChanges = replacing && chosen.local.contentStatus !== 'verified';
  const ready = chosen !== undefined && canTake(chosen) && (!replacing || !modified || discard);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !ready) return;
    setError(null);
    setBusy(true);
    try {
      await startRestore({
        agentId: chosen.agentId,
        emulatorType: vm.emulatorType,
        vmName: vm.vmName,
        versionId: version.versionId,
        ...(replacing
          ? {
              replace: {
                expectedVersionId: chosen.local.sourceVersionId,
                discardLocalChanges: discard,
              },
            }
          : {}),
      });
      onStarted();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const needed =
    version.totalUncompressedBytes !== null
      ? version.archiveSizeBytes + version.totalUncompressedBytes
      : null;

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-dialog-title"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="restore-dialog-title" className="h5 card-title">
            {replacing ? `Replace the local copy of ${vm.vmName}` : `Restore ${vm.vmName}`}
          </h2>
          {replacing ? (
            <p className="small">
              This replaces the persistent local copy on {chosen.agentName} with the immutable
              version you choose. The new version is downloaded, verified and extracted beside the
              current copy first; only then is the current copy moved aside and removed. If anything
              fails before that, the current copy is left as it is. The VM is not started.
            </p>
          ) : (
            <p className="small">
              This creates a local copy of the immutable version you choose on the agent you choose.
              The version is not changed, an existing directory is never overwritten, and the VM is
              not started. A snapshot made from the restored copy afterwards branches from this
              version.
            </p>
          )}
          <FormError error={error} />
          {versions.length > 1 ? (
            <div className="mb-3">
              <label htmlFor="restore-version" className="form-label">
                Version
              </label>
              <select
                id="restore-version"
                className="form-select"
                value={versionId}
                onChange={(event) => setVersionId(event.target.value)}
              >
                {versions.map((item) => (
                  <option
                    key={item.versionId}
                    value={item.versionId}
                    disabled={!item.repositoryEnabled}
                  >
                    {versionLabel(item)}, {formatTime(item.createdAt)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="mb-3">
            <label htmlFor="restore-agent" className="form-label">
              Target agent
            </label>
            <select
              id="restore-agent"
              ref={select}
              className="form-select"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setDiscard(false);
              }}
            >
              {options.agents.map((agent) => {
                const reason = refusal(agent);
                return (
                  <option key={agent.agentId} value={agent.agentId} disabled={!canTake(agent)}>
                    {agent.agentName}
                    {reason
                      ? ` (${INELIGIBLE_TEXT[reason]})`
                      : replaces(agent)
                        ? ' (replaces its copy)'
                        : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <dl className="small settings-facts">
            <dt>VM</dt>
            <dd className="vm-identity">{vm.vmName}</dd>
            <dt>Emulator</dt>
            <dd>{EMULATOR_LABELS[vm.emulatorType]}</dd>
            {replacing ? (
              <>
                <dt>Target agent</dt>
                <dd>{chosen.agentName}</dd>
                <dt>Installed now</dt>
                <dd>
                  {chosen.local.sourceVersionId ? (
                    <>
                      {nameVersion(chosen.local.sourceVersionId)}{' '}
                      <span className="vm-identity">{chosen.local.sourceVersionId}</span>
                    </>
                  ) : (
                    'A copy whose version is not known'
                  )}
                </dd>
                <dt>Local changes</dt>
                <dd>
                  {modified
                    ? 'Modified: it differs from its version'
                    : mayHaveChanges
                      ? 'Not known: not verified since the agent last connected'
                      : 'None: verified against its version'}
                </dd>
              </>
            ) : null}
            <dt>{replacing ? 'Replaced by' : 'Version'}</dt>
            <dd>
              {versionLabel(version)} <span className="vm-identity">{version.versionId}</span>
            </dd>
            <dt>Archive size</dt>
            <dd>{formatBytes(version.archiveSizeBytes)}</dd>
            <dt>Repository</dt>
            <dd>{version.repositoryName}</dd>
            <dt>Destination</dt>
            <dd className="vm-identity">
              {chosen?.destination ?? 'Decided by the agent, in its base path'}
            </dd>
            <dt>Local availability</dt>
            <dd>{chosen ? localText(chosen) : 'No agent chosen'}</dd>
            <dt>Disk space needed</dt>
            <dd>
              {needed !== null
                ? `Up to ${formatBytes(needed)}, for the download and the extracted files`
                : 'Not known until the agent has read the archive'}
            </dd>
          </dl>
          {replacing ? (
            <div className="border-top pt-3 mb-3">
              <div className="alert alert-danger small" role="alert">
                The existing local copy of <span className="vm-identity">{vm.vmName}</span> on{' '}
                {chosen.agentName} will be replaced. Changes in it that are not preserved in a
                snapshot may be permanently lost.
              </div>
              {mayHaveChanges ? (
                <div className="alert alert-warning small" role="alert">
                  {modified
                    ? 'The current copy differs from its version: it holds changes that are in no snapshot.'
                    : 'The current copy has not been verified since the agent last connected, so it may hold changes that are in no snapshot.'}{' '}
                  Replacing it removes them for good.
                  {onSnapshotFirst && chosen.local.sourceVersionId ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-primary"
                        onClick={() =>
                          onSnapshotFirst({
                            agentId: chosen.agentId,
                            agentName: chosen.agentName,
                            parentVersionId: chosen.local.sourceVersionId!,
                            parentLabel: nameVersion(chosen.local.sourceVersionId),
                          })
                        }
                      >
                        Snapshot it first…
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="form-check mb-0">
                <input
                  id="restore-discard"
                  className="form-check-input"
                  type="checkbox"
                  checked={discard}
                  onChange={(event) => setDiscard(event.target.checked)}
                  aria-describedby="restore-discard-help"
                />
                <label className="form-check-label" htmlFor="restore-discard">
                  Discard any changes in the current copy
                </label>
                <div id="restore-discard-help" className="form-text mt-0">
                  {modified
                    ? 'Required: the current copy is known to differ.'
                    : 'Without this, the agent first verifies the current copy against its version, and refuses if anything differs.'}
                </div>
              </div>
            </div>
          ) : null}
          <div className="d-flex flex-wrap gap-2">
            <button
              type="submit"
              className={`btn ${replacing ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || !ready}
            >
              {busy
                ? 'Starting…'
                : !replacing
                  ? 'Restore'
                  : discard
                    ? 'Discard changes and replace VM'
                    : 'Replace existing VM'}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary theme-button"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * The agents' persistent copies of this VM, restoring or replacing one, and every restore. Administrators
 * only.
 */
export function VmRestoreSection({ vm }: { vm: VmIdentity }) {
  const { emulatorType, vmName } = vm;
  const identity = { emulatorType, vmName };
  const loadOperations = useCallback(
    (signal: AbortSignal) => fetchRestores({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadOptions = useCallback(
    (signal: AbortSignal) => fetchRestoreOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const [fastPoll, setFastPoll] = useState(false);
  const operations = usePolledData(loadOperations, fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  const options = usePolledData(loadOptions, fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [snapshotFirst, setSnapshotFirst] = useState<SnapshotRequest | null>(null);
  const [snapshotOperation, setSnapshotOperation] = useState<RegistrationOperation | null>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);

  const list = operations.data?.operations ?? [];
  const active = list.some((operation) => !isRestoreTerminal(operation.state));
  if (active !== fastPoll) setFastPoll(active);

  const refresh = () => {
    operations.refresh();
    options.refresh();
  };
  const closeDialog = () => {
    setDialogOpen(false);
    restoreButton.current?.focus();
  };

  const master = options.data?.master ?? null;
  const agents = options.data?.agents ?? [];
  const canRestore = agents.some(canTake);
  const nameVersion = versionNamer(options.data);

  return (
    <section className="card" aria-labelledby="vm-restore-heading">
      <div className="card-body">
        <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
          <h2 id="vm-restore-heading" className="h6 card-title mb-0 flex-grow-1">
            Local copies and restores
          </h2>
          {master ? (
            <button
              ref={restoreButton}
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!canRestore}
              aria-haspopup="dialog"
              onClick={() => setDialogOpen(true)}
            >
              Restore…
            </button>
          ) : null}
        </div>
        {options.error && !options.data ? (
          <p className="small text-body-secondary">This information is not available right now.</p>
        ) : null}
        {options.data && !master ? (
          <p className="small">This VM has no master version to restore.</p>
        ) : null}
        {snapshotOperation ? (
          <SnapshotProgress
            key={snapshotOperation.id}
            operationId={snapshotOperation.id}
            onFinished={refresh}
          />
        ) : null}
        {master ? (
          <p className="small text-body-secondary">
            Each agent holds at most one persistent copy of this VM, the one Local mode runs. Any
            version can be restored to it; on an agent that already holds one, restoring replaces
            it, after a confirmation. The master is{' '}
            <span className="vm-identity" title={master.versionId}>
              {shortId(master.versionId)}
            </span>
            , {formatBytes(master.archiveSizeBytes)} in {master.repositoryName}.
          </p>
        ) : null}
        {agents.length > 0 ? (
          <div className="table-responsive mb-3">
            <table className="table table-sm small align-middle mb-0">
              <caption className="visually-hidden">Persistent copies of {vmName}</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Persistent copy</th>
                  <th scope="col">Version</th>
                  <th scope="col">Restore</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const reason = refusal(agent);
                  return (
                    <tr key={agent.agentId}>
                      <td>
                        <Link to={`/admin/agents/${agent.agentId}`}>{agent.agentName}</Link>
                        {agent.online ? null : (
                          <span className="badge text-bg-secondary ms-1">Offline</span>
                        )}
                      </td>
                      <td>{localText(agent)}</td>
                      <td>
                        {agent.local.availability === 'present'
                          ? nameVersion(agent.local.sourceVersionId)
                          : '—'}
                      </td>
                      <td>
                        {canTake(agent)
                          ? replaces(agent)
                            ? 'Can be replaced'
                            : 'Can be restored'
                          : reason
                            ? `Not now: ${INELIGIBLE_TEXT[reason]}`
                            : 'Not now'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {master && !canRestore && options.data ? (
          <p className="small text-body-secondary">No agent can restore this VM right now.</p>
        ) : null}
        {list.length > 0 ? (
          <>
            <h3 className="h6 mt-3">Restore history</h3>
            <RestoreHistory operations={list} nameVersion={nameVersion} onChange={refresh} />
          </>
        ) : null}
      </div>
      {dialogOpen && options.data ? (
        <RestoreDialog
          vm={identity}
          options={options.data}
          onClose={closeDialog}
          onStarted={() => {
            closeDialog();
            refresh();
          }}
          onSnapshotFirst={(request) => {
            setDialogOpen(false);
            setSnapshotFirst(request);
          }}
        />
      ) : null}
      {snapshotFirst ? (
        <CreateSnapshotDialog
          vm={identity}
          request={snapshotFirst}
          onClose={() => {
            setSnapshotFirst(null);
            restoreButton.current?.focus();
          }}
          onStarted={(operation) => {
            setSnapshotFirst(null);
            setSnapshotOperation(operation);
            restoreButton.current?.focus();
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/** An agent's recent restores, for its page. */
export function AgentRestores({ agentId }: { agentId: string }) {
  const load = useCallback((signal: AbortSignal) => fetchRestores({ agentId }, signal), [agentId]);
  const [fastPoll, setFastPoll] = useState(false);
  const { data, refresh } = usePolledData(load, fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  const list = data?.operations ?? [];
  const active = list.some((operation) => !isRestoreTerminal(operation.state));
  if (active !== fastPoll) setFastPoll(active);
  if (list.length === 0) return null;
  return (
    <section className="mt-4" aria-labelledby="restores-heading">
      <h2 id="restores-heading" className="h5">
        Restores
      </h2>
      <RestoreHistory operations={list} showVm onChange={refresh} />
    </section>
  );
}
