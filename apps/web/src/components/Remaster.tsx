import {
  characterCount,
  REMASTER_PHASE_LABELS,
  VERSION_DESCRIPTION_MAX_LENGTH,
  VERSION_TITLE_MAX_LENGTH,
  type RemasterOperation,
  type RemasterPhase,
  type RemasterPreview,
  type RemasterVersion,
  type VersionNode,
  type VmIdentity,
} from '@emucat/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  fetchLocalRemasterPreview,
  fetchPromotionPreview,
  fetchRemaster,
  promoteSnapshot,
  remasterFromLocalCopy,
  retryRemasterCleanup,
  updateVersionDetails,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
import { shortId, versionLabel } from './Snapshots';
import { FormError } from './States';

/**
 * Master and snapshot lifecycle (decision 0048): promoting a snapshot to master, replacing the whole history
 * with an agent's local copy, and a version's title and description. Every remaster is previewed first and
 * names the history it was previewed from, so a page that has fallen behind is refused rather than obeyed.
 */

const ACTIVE_POLL_MS = 1_500;

/** A version as a person reads it: its title when it has one, with its label and short ID. */
function VersionLine({ version }: { version: RemasterVersion }) {
  return (
    <li>
      {version.title ? <strong>{version.title}</strong> : null}
      {version.title ? ' — ' : null}
      {versionLabel(version)} <span className="vm-identity">{shortId(version.id)}</span>
      <span className="text-body-secondary">
        {' '}
        ({formatTime(version.createdAt)}, {formatBytes(version.archiveSizeBytes)})
      </span>
    </li>
  );
}

function VersionList({ versions, empty }: { versions: RemasterVersion[]; empty: string }) {
  if (versions.length === 0) return <p className="mb-2 text-body-secondary">{empty}</p>;
  return (
    <ul className="mb-2 remaster-list" style={{ maxHeight: '12rem', overflowY: 'auto' }}>
      {versions.map((version) => (
        <VersionLine key={version.id} version={version} />
      ))}
    </ul>
  );
}

/** A dialog with its own form. Focus goes in when it opens and Escape closes it. */
function RemasterDialog({
  title,
  labelId,
  children,
  onClose,
  onSubmit,
}: {
  title: string;
  labelId: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLHeadingElement>(null);
  useModalDialog(dialog, first, onClose);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <form className="card-body small" onSubmit={submit}>
          <h2 id={labelId} ref={first} tabIndex={-1} className="h5 card-title">
            {title}
          </h2>
          {children}
        </form>
      </div>
    </div>
  );
}

/** What a preview says will happen, and what has to be acknowledged first. */
function PreviewBody({
  preview,
  acknowledged,
  onAcknowledge,
}: {
  preview: RemasterPreview;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}) {
  const promotion = preview.kind === 'snapshot';
  return (
    <>
      <dl className="version-facts mb-2">
        <div>
          <dt>Current master</dt>
          <dd>
            {preview.currentMaster.title ? `${preview.currentMaster.title} — ` : ''}
            <span className="vm-identity">{shortId(preview.currentMaster.id)}</span>
          </dd>
        </div>
        {preview.promoted ? (
          <div>
            <dt>Becomes the master</dt>
            <dd>
              {preview.promoted.title ? <strong>{preview.promoted.title}</strong> : null}
              {preview.promoted.title ? ' — ' : ''}
              {versionLabel(preview.promoted)}{' '}
              <span className="vm-identity">{shortId(preview.promoted.id)}</span>
            </dd>
          </div>
        ) : null}
        {preview.source ? (
          <div>
            <dt>Exported from</dt>
            <dd>
              {preview.source.sourceName} on {preview.source.agentName}
              {preview.source.online ? '' : ' (offline)'}
            </dd>
          </div>
        ) : null}
      </dl>
      {promotion ? (
        <>
          <h3 className="h6">Kept ({preview.retained.length})</h3>
          <p className="mb-1 text-body-secondary">
            The promoted snapshot and every version descended from it, chosen by lineage, not by
            date. Their archives are reused as they are.
          </p>
          <VersionList versions={preview.retained} empty="Nothing is kept." />
        </>
      ) : null}
      <h3 className="h6">
        Permanently deleted ({preview.removed.length}, {formatBytes(preview.removedBytes)})
      </h3>
      <VersionList versions={preview.removed} empty="Nothing is deleted." />
      <div className="alert alert-danger small" role="alert">
        {promotion
          ? 'The versions above, the current master included, leave the history and their archives are deleted from the repository. This cannot be undone.'
          : 'Once the new master is uploaded, verified and recorded, every version above leaves the history and its archive is deleted from the repository. This cannot be undone. Nothing is deleted if the export fails.'}
        {preview.cleanupAvailable
          ? ''
          : ' No online agent can delete these archives right now: they are deleted once one can.'}
      </div>
      {preview.lineageConflicts.length > 0 ? (
        <div className="alert alert-warning small">
          <p className="mb-1">
            These copies come from a version that would be deleted. They are kept exactly as they
            are and can still be run, but they need a restore
            {preview.emulatorType === 'virtualbox' ? ' (an import and relink)' : ''} before their
            next snapshot:
          </p>
          <ul className="mb-2">
            {preview.lineageConflicts.map((conflict) => (
              <li key={`${conflict.agentId}/${conflict.versionId}`}>
                {conflict.agentName}: from {conflict.versionLabel}{' '}
                <span className="vm-identity">{shortId(conflict.versionId)}</span>
              </li>
            ))}
          </ul>
          <div className="form-check">
            <input
              id="remaster-acknowledge"
              type="checkbox"
              className="form-check-input"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            <label htmlFor="remaster-acknowledge" className="form-check-label">
              I understand these copies need a restore before their next snapshot
            </label>
          </div>
        </div>
      ) : null}
      {preview.refusal ? (
        <div className="alert alert-secondary small" role="status">
          Cannot be done now: {preview.refusal.message}
        </div>
      ) : null}
    </>
  );
}

function DialogButtons({
  action,
  busy,
  disabled,
  onClose,
}: {
  action: string;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  return (
    <div className="d-flex flex-wrap gap-2">
      <button type="submit" className="btn btn-danger" disabled={busy || disabled}>
        {busy ? 'Working…' : action}
      </button>
      <button type="button" className="btn btn-outline-secondary theme-button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/** Previews and confirms promoting a snapshot to master. One request ID per dialog. */
export function PromoteSnapshotDialog({
  vm,
  node,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  node: VersionNode;
  onClose: () => void;
  onStarted: (operation: RemasterOperation) => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<RemasterPreview | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { emulatorType, vmName } = vm;

  useEffect(() => {
    const controller = new AbortController();
    fetchPromotionPreview({ emulatorType, vmName }, node.id, controller.signal).then(
      setPreview,
      (failure: unknown) => {
        if (!controller.signal.aborted) setLoadError(failure);
      },
    );
    return () => controller.abort();
  }, [emulatorType, vmName, node.id]);

  const conflicts = (preview?.lineageConflicts.length ?? 0) > 0;
  const ready = preview !== null && preview.refusal === null && (!conflicts || acknowledged);

  const submit = async () => {
    if (!preview || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const operation = await promoteSnapshot(vm, node.id, {
        requestId,
        expectedRevision: preview.revision,
        ...(conflicts ? { acknowledgeLineageConflicts: true } : {}),
      });
      onStarted(operation);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <RemasterDialog
      title={`Promote ${node.title ?? versionLabel(node)} to master`}
      labelId="promote-dialog-title"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p>
        This snapshot becomes the master of {vm.vmName}. It keeps its archive, title, description
        and creation time; the promotion is recorded separately.
      </p>
      <FormError error={loadError} />
      {preview ? (
        <PreviewBody
          preview={preview}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      ) : loadError ? null : (
        <p role="status">Working out what would be kept and deleted…</p>
      )}
      <FormError error={error} />
      <DialogButtons action="Promote to master" busy={busy} disabled={!ready} onClose={onClose} />
    </RemasterDialog>
  );
}

/** A copy that can be exported as the new master. */
export interface RemasterSourceChoice {
  agentId: string;
  agentName: string;
}

/** Previews and confirms replacing the whole history with one agent's local copy. */
export function LocalRemasterDialog({
  vm,
  choices,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  choices: RemasterSourceChoice[];
  onClose: () => void;
  onStarted: (operation: RemasterOperation) => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [agentId, setAgentId] = useState(choices[0]?.agentId ?? '');
  // Each answer is kept with the agent it is for, so choosing another one shows nothing stale.
  const [loaded, setLoaded] = useState<{ agentId: string; preview: RemasterPreview } | null>(null);
  const [failed, setFailed] = useState<{ agentId: string; error: unknown } | null>(null);
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const { emulatorType, vmName } = vm;
  const preview = loaded?.agentId === agentId ? loaded.preview : null;
  const loadError = failed?.agentId === agentId ? failed.error : null;
  const acknowledged = acknowledgedFor === agentId;
  const setAcknowledged = (value: boolean) => setAcknowledgedFor(value ? agentId : null);

  useEffect(() => {
    if (!agentId) return undefined;
    const controller = new AbortController();
    fetchLocalRemasterPreview({ emulatorType, vmName }, agentId, controller.signal).then(
      (answer) => setLoaded({ agentId, preview: answer }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setFailed({ agentId, error: failure });
      },
    );
    return () => controller.abort();
  }, [emulatorType, vmName, agentId]);

  const conflicts = (preview?.lineageConflicts.length ?? 0) > 0;
  // The exact name, as the server compares it: this replaces everything.
  const named = typed === vmName;
  const ready =
    preview !== null && preview.refusal === null && (!conflicts || acknowledged) && named;

  const submit = async () => {
    if (!preview || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const operation = await remasterFromLocalCopy(vm, {
        agentId,
        requestId,
        expectedRevision: preview.revision,
        confirmVmName: typed,
        ...(conflicts ? { acknowledgeLineageConflicts: true } : {}),
      });
      onStarted(operation);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <RemasterDialog
      title="Remaster from a local copy"
      labelId="local-remaster-dialog-title"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p>
        The agent exports its local copy of {vm.vmName} as a new master, uploads it and verifies it
        in the repository. Only then does it replace the whole version history.{' '}
        {vm.emulatorType === 'virtualbox'
          ? 'The linked machine must be powered off, and stays linked to the new master.'
          : 'The VM must not be running there.'}{' '}
        No emulator is stopped and no local copy is deleted.
      </p>
      {choices.length > 1 ? (
        <>
          <label htmlFor="local-remaster-agent" className="form-label">
            Local copy
          </label>
          <select
            id="local-remaster-agent"
            className="form-select mb-2"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.agentId} value={choice.agentId}>
                {choice.agentName}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <FormError error={loadError} />
      {preview ? (
        <PreviewBody
          preview={preview}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      ) : loadError ? null : (
        <p role="status">Checking the local copy and the version history…</p>
      )}
      <label htmlFor="local-remaster-name" className="form-label">
        Type <span className="vm-identity">{vm.vmName}</span> to confirm
      </label>
      <input
        id="local-remaster-name"
        className="form-control mb-3"
        autoComplete="off"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <FormError error={error} />
      <DialogButtons action="Replace the history" busy={busy} disabled={!ready} onClose={onClose} />
    </RemasterDialog>
  );
}

const LOCAL_PHASES: RemasterPhase[] = [
  'exporting',
  'uploading',
  'verifying',
  'committing',
  'cleaning',
  'completed',
];

/** A remaster, followed until its obsolete archives are all gone, or it fails. */
export function RemasterProgress({
  remasterId,
  onChanged,
}: {
  remasterId: string;
  /** Called when the history may have changed: when the new master is recorded, and when it ends. */
  onChanged: () => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => fetchRemaster(remasterId, signal),
    [remasterId],
  );
  const [seen, setSeen] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [finished, setFinished] = useState(false);
  const { data, refresh } = usePolledData(load, finished ? null : ACTIVE_POLL_MS);
  const marker = data ? `${data.state}/${data.cleanup.deleted}` : null;
  if (marker !== null && marker !== seen) {
    setSeen(marker);
    if (seen !== null) onChanged();
  }
  const terminal = data?.state === 'completed' || data?.state === 'failed';
  if (terminal !== finished) setFinished(terminal);
  if (!data) return null;

  const failed = data.state === 'failed';
  const done = data.state === 'completed';
  const percent =
    data.phase === 'uploading' && data.progress.doneBytes !== null && data.progress.totalBytes
      ? Math.round((100 * data.progress.doneBytes) / data.progress.totalBytes)
      : null;
  const phases: RemasterPhase[] =
    data.kind === 'local_copy' ? LOCAL_PHASES : ['committing', 'cleaning', 'completed'];
  const current = phases.indexOf(data.phase);
  const cleanupErrors = data.cleanup.items.filter((item) => item.error !== null);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryRemasterCleanup(data.id);
      refresh();
    } catch (failure) {
      setRetryError(failure);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className={`alert ${failed ? 'alert-danger' : done ? 'alert-success' : 'alert-info'} small`}
      role="status"
      aria-live="polite"
    >
      <strong>
        {data.kind === 'snapshot' ? 'Promotion to master' : 'Remaster from a local copy'}
        {data.agentName ? ` (${data.agentName})` : ''}
      </strong>
      : {REMASTER_PHASE_LABELS[data.phase]}
      {percent !== null ? ` (${percent}%)` : null}
      {!failed ? (
        <ol className="list-inline mb-1 mt-1" aria-label="Steps">
          {phases.map((phase, index) => (
            <li
              key={phase}
              className={`list-inline-item badge ${index < current || done ? 'text-bg-success' : index === current ? 'text-bg-primary' : 'text-bg-light border'}`}
              aria-current={index === current ? 'step' : undefined}
            >
              {REMASTER_PHASE_LABELS[phase]}
            </li>
          ))}
        </ol>
      ) : null}
      {data.error ? <div className="mt-1">{data.error.message}</div> : null}
      {failed && data.kind === 'local_copy' ? (
        <div className="mt-1">The version history was not changed.</div>
      ) : null}
      {data.state === 'cleaning' || done ? (
        <div className="mt-1">
          {data.cleanup.deleted} of {data.cleanup.total} obsolete archives deleted (
          {formatBytes(data.removedBytes)}).
          {data.state === 'cleaning'
            ? ' The new master is already in use; the rest are deleted as an agent can.'
            : ''}
        </div>
      ) : null}
      {cleanupErrors.length > 0 && data.state === 'cleaning' ? (
        <div className="mt-1">
          <ul className="mb-1">
            {cleanupErrors.map((item) => (
              <li key={item.versionId}>
                {item.label} <span className="vm-identity">{shortId(item.versionId)}</span>: (
                <span className="vm-identity">{item.error?.code}</span>) {item.error?.message}
              </li>
            ))}
          </ul>
          It is tried again automatically.{' '}
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button"
            disabled={retrying}
            onClick={() => void retry()}
          >
            Retry cleanup now
          </button>
        </div>
      ) : null}
      <FormError error={retryError} />
    </div>
  );
}

/** Edits a version's title and description. Its archive, lineage and creation time never change. */
export function EditVersionDetailsDialog({
  vm,
  node,
  onClose,
  onSaved,
}: {
  vm: VmIdentity;
  node: VersionNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(node.title ?? '');
  const [description, setDescription] = useState(node.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const titleLength = characterCount(title.trim());
  const descriptionLength = characterCount(description.replace(/\r\n?/g, '\n').trim());
  const valid =
    titleLength <= VERSION_TITLE_MAX_LENGTH && descriptionLength <= VERSION_DESCRIPTION_MAX_LENGTH;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await updateVersionDetails(vm, node.id, { title, description });
      onSaved();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <RemasterDialog
      title={`Edit details of ${versionLabel(node)}`}
      labelId="version-details-dialog-title"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p className="text-body-secondary">
        Only the title and description change. The archive, its lineage and its creation time stay
        as they are.
      </p>
      <VersionDetailsFields
        title={title}
        description={description}
        onTitle={setTitle}
        onDescription={setDescription}
      />
      <FormError error={error} />
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-outline-secondary theme-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </RemasterDialog>
  );
}

/** The optional title and description of a version, with what is left of their limits. */
export function VersionDetailsFields({
  title,
  description,
  onTitle,
  onDescription,
}: {
  title: string;
  description: string;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
}) {
  const titleLength = characterCount(title.trim());
  const descriptionLength = characterCount(description.replace(/\r\n?/g, '\n').trim());
  return (
    <>
      <label htmlFor="version-title" className="form-label">
        Title <span className="text-body-secondary">(optional)</span>
      </label>
      <input
        id="version-title"
        className={`form-control${titleLength > VERSION_TITLE_MAX_LENGTH ? ' is-invalid' : ''}`}
        autoComplete="off"
        value={title}
        aria-describedby="version-title-count"
        onChange={(event) => onTitle(event.target.value.replace(/[\r\n]+/g, ' '))}
      />
      <div id="version-title-count" className="form-text mb-2">
        {titleLength} / {VERSION_TITLE_MAX_LENGTH} characters
      </div>
      <label htmlFor="version-description" className="form-label">
        Description <span className="text-body-secondary">(optional, plain text)</span>
      </label>
      <textarea
        id="version-description"
        className={`form-control${descriptionLength > VERSION_DESCRIPTION_MAX_LENGTH ? ' is-invalid' : ''}`}
        rows={5}
        value={description}
        aria-describedby="version-description-count"
        onChange={(event) => onDescription(event.target.value)}
      />
      <div id="version-description-count" className="form-text mb-3">
        {descriptionLength} / {VERSION_DESCRIPTION_MAX_LENGTH} characters
      </div>
    </>
  );
}
