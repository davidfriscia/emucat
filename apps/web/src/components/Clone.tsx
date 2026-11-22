import {
  adminVmRoute,
  CLONE_REFUSAL_TEXT,
  cloneSourceVersionLabel,
  isRegistrationTerminal,
  registrationRecovery,
  validateVmName,
  vmNameKey,
  type RegistrationOperation,
  type VersionNode,
  type VmCloneProvenance,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { cloneVm, fetchCloneOptions, fetchRegistration } from '../api';
import { useAsync } from '../useAsync';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
import { versionLabel } from './Snapshots';
import { FormError, LoadingState } from './States';
import { NAME_ERROR_TEXT } from './VirtualBox';

/**
 * Cloning a version into a new, independent VM (decision 0052). The dialog names the source, the version and the
 * new name, and says what a clone is. Progress is the clone's registration operation, polled until it ends.
 */

const ACTIVE_POLL_MS = 1_500;

const STATE_TEXT: Record<string, string> = {
  queued: 'Waiting for the agent',
  validating: 'Checking the source',
  archiving: 'Downloading and writing the clone',
  uploading: 'Uploading the clone',
  verifying: 'Verifying the clone in the repository',
  committing: 'Registering the new VM',
  cleaning_local: 'Finishing',
  succeeded: 'Cloned',
  failed: 'Failed',
  cancelled: 'Cancelled',
  partial_success: 'Cloned, with a problem',
};

export function CloneVmDialog({
  vm,
  title,
  node,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  /** The source VM's title, as the page shows it. */
  title: string;
  node: VersionNode;
  onClose: () => void;
  onStarted: (operation: RegistrationOperation) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useModalDialog(dialog, nameInput, onClose);
  const ids = useId();
  const [requestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) => fetchCloneOptions({ emulatorType, vmName }, node.id, signal),
    [emulatorType, vmName, node.id],
  );
  const { state } = useAsync(load);
  const options = state.status === 'success' ? state.data : null;
  const eligible = options?.agents.filter((agent) => agent.eligible) ?? [];
  const chosen = agentId ?? eligible[0]?.agentId ?? null;

  const trimmed = name.trim();
  const validation = validateVmName(trimmed);
  const sameName = validation.ok && vmNameKey(trimmed) === vmNameKey(vm.vmName);
  const nameProblem = !validation.ok
    ? NAME_ERROR_TEXT[validation.code]
    : sameName
      ? 'A clone needs a name of its own.'
      : null;
  const canSubmit = !busy && nameProblem === null && chosen !== null && options?.refusal === null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit || chosen === null) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await cloneVm(vm, node.id, { agentId: chosen, vmName: trimmed, requestId }));
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const sourceLabel = node.title ? `${versionLabel(node)} — ${node.title}` : versionLabel(node);
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-explanation`}
      >
        <form className="card-body" onSubmit={(event) => void submit(event)} noValidate>
          <h2 id={`${ids}-title`} className="h5 card-title">
            Clone VM
          </h2>
          <dl className="small settings-facts mb-2">
            <dt>Source VM</dt>
            <dd>
              {title} <span className="vm-identity">({vm.vmName})</span>
            </dd>
            <dt>Source version</dt>
            <dd>
              {node.kind === 'master' ? 'Master' : 'Snapshot'}: {sourceLabel}
              {options ? ` · ${formatBytes(options.source.archiveSizeBytes)}` : null}
            </dd>
          </dl>
          <p id={`${ids}-explanation`} className="small mb-3">
            The clone is a new, independent {vm.emulatorType} VM with exactly the files and
            configuration of this version, as its own master. It has its own history, storage and
            screenshots, and is private. It does not get this VM’s snapshots, tags, notes or
            screenshots, and keeps working if this VM is later deleted. This VM is not changed.
          </p>
          <label htmlFor={`${ids}-name`} className="form-label">
            New VM name
          </label>
          <input
            id={`${ids}-name`}
            ref={nameInput}
            className={`form-control${touched && nameProblem ? ' is-invalid' : ''}`}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={name}
            aria-invalid={touched && nameProblem !== null}
            aria-describedby={`${ids}-name-help`}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <div
            id={`${ids}-name-help`}
            className={touched && nameProblem ? 'invalid-feedback d-block' : 'form-text'}
          >
            {touched && nameProblem
              ? nameProblem
              : 'Letters, digits, spaces, dots, hyphens and underscores. Names ignore case, and must not be taken.'}
          </div>
          {vm.emulatorType === 'virtualbox' ? (
            <p className="small text-body-secondary mt-2 mb-0">
              The OVA is copied as it is. Import the clone’s master into VirtualBox to get a new
              machine of its own; it is never linked to this VM’s machine.
            </p>
          ) : null}
          <div className="mt-3">
            {state.status === 'loading' ? <LoadingState label="Finding agents" /> : null}
            {options?.refusal ? (
              <div className="alert alert-warning small mb-2" role="alert">
                {CLONE_REFUSAL_TEXT[options.refusal]}
              </div>
            ) : null}
            {options && options.agents.length > 0 ? (
              <>
                <label htmlFor={`${ids}-agent`} className="form-label">
                  Agent that makes the copy
                </label>
                <select
                  id={`${ids}-agent`}
                  className="form-select"
                  value={chosen ?? ''}
                  aria-describedby={`${ids}-agent-help`}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {eligible.length === 0 ? <option value="">No agent can clone now</option> : null}
                  {options.agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId} disabled={!agent.eligible}>
                      {agent.agentName}
                      {agent.reason ? ` — ${CLONE_REFUSAL_TEXT[agent.reason]}` : ''}
                    </option>
                  ))}
                </select>
                <div id={`${ids}-agent-help`} className="form-text">
                  It downloads the archive from the repository and uploads the copy. Nothing on its
                  disk outside its staging directory is touched.
                </div>
              </>
            ) : null}
            {options && options.agents.length === 0 ? (
              <p className="small text-body-secondary mb-0">
                No agent is associated with the repository that holds this version.
              </p>
            ) : null}
          </div>
          <div className="mt-3">
            <FormError error={error} />
          </div>
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {busy ? 'Starting…' : 'Clone VM'}
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

/** A clone in progress, then how it ended, with a link to the new VM once it exists. */
export function CloneProgress({
  operationId,
  onFinished,
}: {
  operationId: string;
  onFinished?: () => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => fetchRegistration(operationId, signal),
    [operationId],
  );
  const [done, setDone] = useState(false);
  const { data } = usePolledData(load, done ? null : ACTIVE_POLL_MS);
  if (data && isRegistrationTerminal(data.state) && !done) {
    setDone(true);
    onFinished?.();
  }
  if (!data) return null;
  const percent =
    data.progress.doneBytes !== null && data.progress.totalBytes
      ? Math.round((100 * data.progress.doneBytes) / data.progress.totalBytes)
      : null;
  const failed = data.state === 'failed' || data.state === 'cancelled';
  const target = { emulatorType: data.emulatorType, vmName: data.vmName };
  return (
    <div
      className={`alert ${failed ? 'alert-danger' : data.state === 'succeeded' ? 'alert-success' : 'alert-info'} small`}
      role="status"
      aria-live="polite"
    >
      <strong>Clone {data.vmName}</strong>: {STATE_TEXT[data.state] ?? data.state}
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
          <Link to={adminVmRoute(target)}>Open {data.vmName}</Link>
        </div>
      ) : null}
    </div>
  );
}

/** Where a clone came from, for its page. A source that is gone is named, without a link. */
export function ClonedFrom({ provenance }: { provenance: VmCloneProvenance }) {
  const source = {
    emulatorType: provenance.sourceEmulatorType,
    vmName: provenance.sourceVmName,
  };
  const name = provenance.sourceDisplayName ?? provenance.sourceVmName;
  return (
    <>
      <dt>Cloned from</dt>
      <dd>
        {provenance.sourceExists ? (
          <Link to={adminVmRoute(source)}>{name}</Link>
        ) : (
          <>
            {name} <span className="text-body-secondary">(no longer in the catalog)</span>
          </>
        )}
        <div className="small text-body-secondary">
          {cloneSourceVersionLabel(provenance)} ·{' '}
          <span className="vm-identity" title={provenance.sourceVersionId}>
            {provenance.sourceVersionId.slice(0, 8)}
          </span>{' '}
          · {formatTime(provenance.clonedAt)}
          {provenance.clonedByDisplayName ? ` by ${provenance.clonedByDisplayName}` : ''}
        </div>
      </dd>
    </>
  );
}
