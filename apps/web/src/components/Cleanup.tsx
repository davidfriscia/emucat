import {
  EMULATOR_LABELS,
  isLocalRemovalTerminal,
  REMOVAL_INELIGIBLE_TEXT,
  SNAPSHOT_DELETE_REFUSAL_TEXT,
  type LocalCopyRemoval,
  type RestoreAgentOption,
  type VersionNode,
  type VmIdentity,
} from '@emucat/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { deleteSnapshot, removeLocalCopy } from '../api';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
import { versionLabel } from './Snapshots';
import { FormError } from './States';

/**
 * Storage cleanup (decision 0041): removing one agent's persistent copy, and permanently deleting a leaf
 * snapshot. Both are confirmed with an explicit button, never by typing a name. What the interface says
 * is only advice: the server decides again under its locks, and the agent again on its disk.
 */

const REMOVAL_STATE_TEXT: Record<LocalCopyRemoval['state'], string> = {
  requested: 'Removing',
  succeeded: 'Removed',
  failed: 'Not removed',
};

export function removalStateText(removal: LocalCopyRemoval): string {
  if (removal.state === 'succeeded' && removal.cleanupPending) {
    return 'Removed; leftovers still being deleted';
  }
  return REMOVAL_STATE_TEXT[removal.state];
}

function removalBadge(removal: LocalCopyRemoval): string {
  if (removal.state === 'succeeded') {
    return removal.cleanupPending ? 'text-bg-warning' : 'text-bg-success';
  }
  return removal.state === 'failed' ? 'text-bg-danger' : 'text-bg-primary';
}

/** Why a copy cannot be removed now, for a table cell or a button's description. */
export function removalReasonText(agent: RestoreAgentOption): string | null {
  return agent.remove.reason ? REMOVAL_INELIGIBLE_TEXT[agent.remove.reason] : null;
}

/** The confirmation for removing one agent's persistent copy. */
export function RemoveLocalCopyDialog({
  vm,
  agent,
  nameVersion,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  agent: RestoreAgentOption;
  nameVersion: (versionId: string | null) => string;
  onClose: () => void;
  onStarted: (removal: LocalCopyRemoval) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, cancel, onClose);
  const [requestId] = useState(() => crypto.randomUUID());
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const modified = agent.local.contentStatus === 'modified';
  const unverified = agent.local.contentStatus !== 'verified' && !modified;
  const ready = agent.remove.eligible && (!modified || discard);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const removal = await removeLocalCopy({
        agentId: agent.agentId,
        emulatorType: vm.emulatorType,
        vmName: vm.vmName,
        expectedVersionId: agent.local.sourceVersionId,
        discardLocalChanges: discard,
        requestId,
      });
      onStarted(removal);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-copy-title"
        aria-describedby="remove-copy-what"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="remove-copy-title" className="h5 card-title">
            Remove the local copy of {vm.vmName}
          </h2>
          <p id="remove-copy-what" className="small">
            This permanently deletes the persistent local copy of{' '}
            <span className="vm-identity">{vm.vmName}</span> from {agent.agentName}, and only there.
            Versions in the repository, the master, snapshots, other agents’ copies and remote
            sessions are not touched. Afterwards this agent can no longer run the VM in Local mode
            until a version is restored to it again; remote modes stay available.
          </p>
          <FormError error={error} />
          <dl className="small settings-facts">
            <dt>Agent</dt>
            <dd>{agent.agentName}</dd>
            <dt>VM</dt>
            <dd className="vm-identity">{vm.vmName}</dd>
            <dt>Emulator</dt>
            <dd>{EMULATOR_LABELS[vm.emulatorType]}</dd>
            <dt>Installed version</dt>
            <dd>
              {agent.local.sourceVersionId ? (
                <>
                  {nameVersion(agent.local.sourceVersionId)}{' '}
                  <span className="vm-identity">{agent.local.sourceVersionId}</span>
                </>
              ) : (
                'Not known'
              )}
            </dd>
            <dt>Local changes</dt>
            <dd>
              {modified
                ? 'Modified: it differs from its version'
                : unverified
                  ? 'Not known: not verified since the agent last connected'
                  : `None: verified, as of ${formatTime(agent.local.lastVerifiedAt)}`}
            </dd>
            <dt>Location</dt>
            <dd className="vm-identity">
              {agent.destination ?? 'Found by the agent in its base path'}
            </dd>
          </dl>
          {modified || unverified ? (
            <div className="border-top pt-3 mb-3">
              <div className="alert alert-warning small" role="alert">
                {modified
                  ? 'This copy holds changes that are in no snapshot. Removing it loses them for good. Snapshot it first if you want to keep them.'
                  : 'This copy has not been verified since the agent last connected. Without the box below, the agent checks it first, and keeps it if anything differs or cannot be proven.'}
              </div>
              <div className="form-check mb-0">
                <input
                  id="remove-copy-discard"
                  className="form-check-input"
                  type="checkbox"
                  checked={discard}
                  onChange={(event) => setDiscard(event.target.checked)}
                  aria-describedby="remove-copy-discard-help"
                />
                <label className="form-check-label" htmlFor="remove-copy-discard">
                  I understand that local changes, and screenshots not yet synchronized, are lost
                </label>
                <div id="remove-copy-discard-help" className="form-text mt-0">
                  {modified
                    ? 'Required: the copy is known to differ from its version.'
                    : 'Optional: removes the copy even if it turns out to differ.'}
                </div>
              </div>
            </div>
          ) : null}
          {!agent.remove.eligible ? (
            <p className="small text-danger">{removalReasonText(agent)}</p>
          ) : null}
          <div className="d-flex flex-wrap gap-2">
            <button type="submit" className="btn btn-danger" disabled={busy || !ready}>
              {busy
                ? 'Removing…'
                : discard
                  ? 'Discard changes and remove local copy'
                  : 'Remove local copy'}
            </button>
            <button
              ref={cancel}
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

/** One removal, however far along it is. */
export function RemovalCard({ removal }: { removal: LocalCopyRemoval }) {
  return (
    <article
      className="border rounded-2 p-3 mb-2 small"
      aria-label={`Removal of the local copy on ${removal.agentName}`}
    >
      <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
        <span className={`badge ${removalBadge(removal)}`}>{removalStateText(removal)}</span>
        <span>Local copy on {removal.agentName}</span>
        {!isLocalRemovalTerminal(removal.state) && !removal.agentOnline ? (
          <span className="badge text-bg-secondary">Agent offline</span>
        ) : null}
        <span className="text-body-secondary ms-auto">{formatTime(removal.createdAt)}</span>
      </div>
      {removal.state === 'requested' ? (
        <p className="mb-0">
          The agent checks the copy, moves it aside and deletes it. Nothing else on that computer is
          touched.
        </p>
      ) : null}
      {removal.error ? (
        <div className="alert alert-danger small mb-0 mt-1" role="alert">
          <strong className="vm-identity">{removal.error.code}</strong>: {removal.error.message}
          {removal.recovery ? <div className="mt-1">{removal.recovery}</div> : null}
        </div>
      ) : null}
      {removal.state === 'succeeded' && removal.localDirectory ? (
        <p className="mb-0">
          Removed from <span className="vm-identity">{removal.localDirectory}</span>
          {removal.requestedByDisplayName ? `, as ${removal.requestedByDisplayName} asked` : ''}.
          {removal.cleanupPending
            ? ' Some files could not be deleted yet; the agent keeps trying. The copy can no longer be found or run.'
            : ''}
        </p>
      ) : null}
    </article>
  );
}

/** Why a snapshot cannot be deleted now. */
export function deletionReasonText(node: VersionNode): string | null {
  if (node.deletion) return 'It is being deleted.';
  return node.deletable.reason ? SNAPSHOT_DELETE_REFUSAL_TEXT[node.deletable.reason] : null;
}

/** The confirmation for deleting a leaf snapshot. It names the exact, immutable version. */
export function DeleteSnapshotDialog({
  vm,
  node,
  parentLabel,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  node: VersionNode;
  parentLabel: string | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, cancel, onClose);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteSnapshot(vm, node.id, requestId);
      onStarted();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-snapshot-title"
        aria-describedby="delete-snapshot-warning"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="delete-snapshot-title" className="h5 card-title">
            Permanently delete this snapshot
          </h2>
          <div id="delete-snapshot-warning" className="alert alert-danger small" role="alert">
            Its archive is deleted from the repository, and the snapshot can no longer be restored,
            run or used as a parent. This cannot be undone. Its parent and every other version are
            kept, and the history of what was done with it stays.
          </div>
          <FormError error={error} />
          <dl className="small settings-facts">
            <dt>VM</dt>
            <dd className="vm-identity">{vm.vmName}</dd>
            <dt>Snapshot</dt>
            <dd>{versionLabel(node)}</dd>
            <dt>Version ID</dt>
            <dd className="vm-identity">{node.id}</dd>
            <dt>Parent</dt>
            <dd>
              {parentLabel ?? 'Unknown'}{' '}
              <span className="vm-identity">{node.parentVersionId ?? ''}</span>
            </dd>
            <dt>Created</dt>
            <dd>{formatTime(node.createdAt)}</dd>
            <dt>Archive size</dt>
            <dd>{formatBytes(node.archiveSizeBytes)}</dd>
            <dt>Repository</dt>
            <dd>{node.repositoryName}, deleted from it by an agent configured for it</dd>
          </dl>
          <div className="d-flex flex-wrap gap-2">
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? 'Deleting…' : 'Permanently delete snapshot'}
            </button>
            <button
              ref={cancel}
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
