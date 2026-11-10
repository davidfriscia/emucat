import {
  EMULATOR_LABELS,
  isRestoreCancellable,
  isRestoreTerminal,
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
import { useModalDialog } from './Gallery';
import { FormError } from './States';

const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;

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
  vm_running: 'the VM is running there',
  operation_in_progress: 'busy with another operation',
};

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
      {operation.state === 'succeeded' ? (
        <p className="small text-body-secondary mb-0">
          The VM was not started. Run it yourself when you want to.
        </p>
      ) : null}
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

function localText(option: RestoreAgentOption): string {
  const { availability, contentStatus, lastVerifiedAt } = option.local;
  if (availability === 'none') return 'No local copy';
  if (availability === 'absent') return 'No longer present on this agent';
  if (contentStatus === 'verified') return `Verified copy, as of ${formatTime(lastVerifiedAt)}`;
  if (contentStatus === 'modified') return 'Has a local copy that differs from the master';
  return 'Has a local copy, not verified since the agent last connected';
}

/** How a version is named for people: the master, or a snapshot's label and when it was made. */
export function versionLabel(version: {
  kind: 'master' | 'snapshot';
  snapshotName: string | null;
}): string {
  return version.kind === 'master' ? 'Master' : (version.snapshotName ?? 'Snapshot');
}

/**
 * The confirmation. It explains what will and will not happen, and offers no way to choose a path. Any
 * version can be restored: the master, or any snapshot in the tree.
 */
export function RestoreDialog({
  vm,
  options,
  initialVersionId,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  options: RestoreOptionsResponse;
  initialVersionId?: string | undefined;
  onClose: () => void;
  onStarted: () => void;
}) {
  const eligible = options.agents.filter((agent) => agent.eligible);
  const [agentId, setAgentId] = useState(eligible[0]?.agentId ?? '');
  const [versionId, setVersionId] = useState(
    initialVersionId ?? options.master?.versionId ?? options.versions[0]?.versionId ?? '',
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useModalDialog(dialog, select, onClose);

  const versions = options.versions.length > 0 ? options.versions : [];
  const master =
    versions.find((version) => version.versionId === versionId) ??
    (options.master ? { ...options.master, kind: 'master' as const, snapshotName: null } : null);
  const chosen = options.agents.find((agent) => agent.agentId === agentId);
  if (!master) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setError(null);
    setBusy(true);
    try {
      await startRestore({
        agentId: chosen.agentId,
        emulatorType: vm.emulatorType,
        vmName: vm.vmName,
        versionId: master.versionId,
      });
      onStarted();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const needed =
    master.totalUncompressedBytes !== null
      ? master.archiveSizeBytes + master.totalUncompressedBytes
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
            Restore {vm.vmName}
          </h2>
          <p className="small">
            This creates a local copy of the immutable version you choose on the agent you choose.
            The version is not changed, an existing directory is never overwritten, and the VM is
            not started. A snapshot made from the restored copy afterwards branches from this
            version.
          </p>
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
                {versions.map((version) => (
                  <option
                    key={version.versionId}
                    value={version.versionId}
                    disabled={!version.repositoryEnabled}
                  >
                    {versionLabel(version)}, {formatTime(version.createdAt)}
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
              onChange={(event) => setAgentId(event.target.value)}
            >
              {options.agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId} disabled={!agent.eligible}>
                  {agent.agentName}
                  {agent.ineligibleReason ? ` (${INELIGIBLE_TEXT[agent.ineligibleReason]})` : ''}
                </option>
              ))}
            </select>
          </div>
          <dl className="small settings-facts">
            <dt>VM</dt>
            <dd className="vm-identity">{vm.vmName}</dd>
            <dt>Emulator</dt>
            <dd>{EMULATOR_LABELS[vm.emulatorType]}</dd>
            <dt>Version</dt>
            <dd>
              {versionLabel(master)} <span className="vm-identity">{master.versionId}</span>
            </dd>
            <dt>Archive size</dt>
            <dd>{formatBytes(master.archiveSizeBytes)}</dd>
            <dt>Repository</dt>
            <dd>{master.repositoryName}</dd>
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
          <div className="d-flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={busy || !chosen?.eligible}>
              {busy ? 'Starting…' : 'Restore'}
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

/** What exists in the repository, who holds a copy, and restoring one. Administrators only. */
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
  const canRestore = agents.some((agent) => agent.eligible);

  return (
    <section className="card" aria-labelledby="vm-restore-heading">
      <div className="card-body">
        <h2 id="vm-restore-heading" className="h6 card-title">
          Master and local copies
        </h2>
        {options.error && !options.data ? (
          <p className="small text-body-secondary">This information is not available right now.</p>
        ) : null}
        {master ? (
          <dl className="small settings-facts">
            <dt>Master version</dt>
            <dd className="vm-identity">{master.versionId}</dd>
            <dt>Created</dt>
            <dd>{formatTime(master.createdAt)}</dd>
            <dt>Repository</dt>
            <dd>{master.repositoryName}</dd>
            <dt>Archive size</dt>
            <dd>{formatBytes(master.archiveSizeBytes)}</dd>
            <dt>Archive SHA-256</dt>
            <dd className="vm-identity">{master.archiveSha256}</dd>
            {master.fileCount !== null ? (
              <>
                <dt>Files</dt>
                <dd>{master.fileCount}</dd>
              </>
            ) : null}
          </dl>
        ) : options.data ? (
          <p className="small">This VM has no master version to restore.</p>
        ) : null}
        {agents.length > 0 ? (
          <>
            <h3 className="h6 mt-3">Agents</h3>
            <ul className="list-unstyled small mb-3">
              {agents.map((agent) => (
                <li key={agent.agentId} className="mb-1">
                  <Link to={`/admin/agents/${agent.agentId}`}>{agent.agentName}</Link>:{' '}
                  {localText(agent)}
                  {agent.online ? '' : ', offline'}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {master ? (
          <>
            <button
              ref={restoreButton}
              type="button"
              className="btn btn-outline-primary"
              disabled={!canRestore}
              onClick={() => setDialogOpen(true)}
            >
              Restore…
            </button>
            {!canRestore && options.data ? (
              <p className="small text-body-secondary mt-2 mb-0">
                No agent can restore this VM right now.{' '}
                {agents
                  .map(
                    (agent) =>
                      `${agent.agentName}: ${agent.ineligibleReason ? INELIGIBLE_TEXT[agent.ineligibleReason] : 'ready'}`,
                  )
                  .join('; ')}
              </p>
            ) : null}
          </>
        ) : null}
        {list.length > 0 ? (
          <div className="mt-3">
            <h3 className="h6">Restores</h3>
            {list.slice(0, 5).map((operation) => (
              <RestoreCard key={operation.id} operation={operation} onChange={refresh} />
            ))}
          </div>
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
      {list.slice(0, 10).map((operation) => (
        <RestoreCard key={operation.id} operation={operation} showVm onChange={refresh} />
      ))}
    </section>
  );
}
