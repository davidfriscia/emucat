import {
  buildVersionTree,
  isRegistrationTerminal,
  registrationRecovery,
  type RegistrationOperation,
  type RestoreOptionsResponse,
  type VersionNode,
  type VersionTreeEntry,
  type VmIdentity,
  type VmWorkspace,
  type WorkspaceState,
} from '@emucat/contracts';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import {
  createSnapshot,
  createWorkspace,
  discardWorkspace,
  fetchRegistration,
  fetchRestoreOptions,
  fetchVersionTree,
  fetchWorkspaces,
  launchWorkspace,
  preserveWorkspace,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
import { RestoreDialog, versionLabel } from './Restore';
import { FormError } from './States';

/**
 * A VM's version history: an immutable master and its snapshots, drawn as the tree they are, with what
 * can be done with each. Administrators only (decision 0039). Nothing here can name a path, a repository
 * or an archive: every action names a version, an agent, or a working copy.
 */

const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;

const WORKSPACE_STATE_TEXT: Record<WorkspaceState, string> = {
  preparing: 'Preparing',
  ready: 'Ready',
  discarding: 'Being discarded',
  discarded: 'Discarded',
  failed: 'Failed',
  lost: 'Lost',
};

const SNAPSHOT_STATE_TEXT: Partial<Record<RegistrationOperation['state'], string>> = {
  queued: 'Waiting for the agent',
  validating: 'Checking the local copy',
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

const shortId = (id: string) => id.slice(0, 8);

function newRequestId(): string {
  return crypto.randomUUID();
}

/** What the agent verified, said plainly: the server never reads an archive itself. */
function verificationText(node: VersionNode): string {
  if (!node.available) return 'Repository disabled, so it cannot be restored now';
  return node.manifest
    ? `Verified by the agent when published: ${node.manifest.fileCount} files, ${formatBytes(node.manifest.totalUncompressedBytes)}`
    : 'Archive hash recorded; manifest details not recorded';
}

function holderText(holder: VersionNode['holders'][number]): string {
  if (holder.kind === 'workspace') return `Working copy on ${holder.agentName}`;
  const status =
    holder.contentStatus === 'verified'
      ? 'verified'
      : holder.contentStatus === 'modified'
        ? 'modified since'
        : 'not verified since it reconnected';
  return `Local copy on ${holder.agentName} (${status})`;
}

/** One version, with its children nested under it. A list inside a list is what keeps branches visible. */
function VersionItem({
  entry,
  vm,
  restoreOptions,
  onRestore,
  onSnapshot,
  onRemote,
}: {
  entry: VersionTreeEntry;
  vm: VmIdentity;
  restoreOptions: RestoreOptionsResponse | null;
  onRestore: (versionId: string) => void;
  onSnapshot: (node: VersionNode, agentId: string, agentName: string) => void;
  onRemote: (node: VersionNode) => void;
}) {
  const { node, depth, children } = entry;
  const [expanded, setExpanded] = useState(true);
  const headingId = `version-${node.id}`;
  const canRestore = node.available && (restoreOptions?.agents.some((a) => a.online) ?? false);
  const localHolders = node.holders.filter((holder) => holder.kind === 'local');
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-labelledby={headingId}
      aria-expanded={children.length > 0 ? expanded : undefined}
      className="version-node"
    >
      <div className="version-card card mb-2">
        <div className="card-body py-2">
          <div className="d-flex flex-wrap align-items-center gap-2">
            {children.length > 0 ? (
              <button
                type="button"
                className="btn btn-sm btn-link p-0 version-toggle"
                aria-label={
                  expanded ? `Collapse ${versionLabel(node)}` : `Expand ${versionLabel(node)}`
                }
                onClick={() => setExpanded((value) => !value)}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              </button>
            ) : null}
            <h4 id={headingId} className="h6 mb-0">
              {versionLabel(node)}
            </h4>
            <span
              className={`badge ${node.kind === 'master' ? 'text-bg-primary' : 'text-bg-secondary'}`}
            >
              {node.kind === 'master' ? 'Root' : 'Snapshot'}
            </span>
            <span className="small text-body-secondary vm-identity" title={node.id}>
              {shortId(node.id)}
            </span>
            {children.length > 1 ? (
              <span className="badge text-bg-light border">{children.length} branches</span>
            ) : null}
          </div>
          <dl className="small version-facts mb-1">
            <div>
              <dt>Created</dt>
              <dd>{formatTime(node.createdAt)}</dd>
            </div>
            <div>
              <dt>Parent</dt>
              <dd className="vm-identity">
                {node.parentVersionId ? shortId(node.parentVersionId) : 'None (root)'}
              </dd>
            </div>
            <div>
              <dt>Archive</dt>
              <dd>{formatBytes(node.archiveSizeBytes)}</dd>
            </div>
            {node.createdByAgentName ? (
              <div>
                <dt>From</dt>
                <dd>{node.createdByAgentName}</dd>
              </div>
            ) : null}
          </dl>
          <p className="small text-body-secondary mb-1">{verificationText(node)}</p>
          {node.holders.length > 0 ? (
            <ul className="list-inline small mb-1">
              {node.holders.map((holder) => (
                <li
                  key={`${holder.agentId}/${holder.workspaceId ?? 'local'}`}
                  className="list-inline-item badge text-bg-light border"
                >
                  {holderText(holder)}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="d-flex flex-wrap gap-2 mt-1">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!canRestore}
              onClick={() => onRestore(node.id)}
            >
              Restore…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!node.available}
              onClick={() => onRemote(node)}
            >
              Launch in Remote Snapshot…
            </button>
            {localHolders.map((holder) => (
              <button
                key={holder.agentId}
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                onClick={() => onSnapshot(node, holder.agentId, holder.agentName)}
              >
                Create snapshot from {holder.agentName}…
              </button>
            ))}
          </div>
        </div>
      </div>
      {children.length > 0 && expanded ? (
        <ul role="group" className="version-children">
          {children.map((child) => (
            <VersionItem
              key={child.node.id}
              entry={child}
              vm={vm}
              restoreOptions={restoreOptions}
              onRestore={onRestore}
              onSnapshot={onSnapshot}
              onRemote={onRemote}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A small confirmation, so that every consequential action is a deliberate one. */
function ConfirmDialog({
  title,
  children,
  action,
  danger = false,
  confirmName,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  action: string;
  danger?: boolean;
  /** When set, this name has to be typed first. */
  confirmName?: string | undefined;
  onConfirm: (typed: string | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement & HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useModalDialog(dialog, first, onClose);
  const matches =
    confirmName === undefined || typed.trim().toLowerCase() === confirmName.toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(confirmName === undefined ? undefined : typed.trim());
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
        aria-labelledby="version-dialog-title"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="version-dialog-title" className="h5 card-title">
            {title}
          </h2>
          <div className="small mb-3">{children}</div>
          <FormError error={error} />
          {confirmName !== undefined ? (
            <>
              <label htmlFor="version-confirm-name" className="form-label">
                Type <span className="vm-identity">{confirmName}</span> to confirm
              </label>
              <input
                id="version-confirm-name"
                ref={first}
                className="form-control mb-3"
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </>
          ) : null}
          <div className="d-flex flex-wrap gap-2">
            <button
              type="submit"
              ref={confirmName === undefined ? first : undefined}
              className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || !matches}
            >
              {busy ? 'Working…' : action}
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

/** Chooses the agent that will run a working copy of a version. */
function RemoteSnapshotDialog({
  vm,
  node,
  options,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  node: VersionNode;
  options: RestoreOptionsResponse | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const agents = (options?.agents ?? []).filter((agent) => agent.online);
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? '');
  // One request per dialog: a retry after a lost answer finds the working copy it already prepared.
  const [requestId] = useState(newRequestId);
  return (
    <ConfirmDialog
      title={`Launch ${versionLabel(node)} in Remote Snapshot`}
      action="Prepare and launch"
      onClose={onClose}
      onConfirm={async () => {
        await createWorkspace(vm, { agentId, versionId: node.id, requestId, launch: true });
        onStarted();
      }}
    >
      <p>
        The agent restores this version into a separate working copy, verified like any restore, and
        launches it there. The persistent local copy is not touched, and the version itself never
        changes. When you stop the VM, nothing is published: you decide afterwards whether to
        preserve the changes as a new snapshot of this version, or to discard them.
      </p>
      <label htmlFor="remote-agent" className="form-label">
        Agent
      </label>
      <select
        id="remote-agent"
        className="form-select"
        value={agentId}
        onChange={(event) => setAgentId(event.target.value)}
      >
        {agents.length === 0 ? <option value="">No agent is online</option> : null}
        {agents.map((agent) => (
          <option key={agent.agentId} value={agent.agentId}>
            {agent.agentName}
          </option>
        ))}
      </select>
    </ConfirmDialog>
  );
}

/** The snapshot being created, followed until it ends. */
function SnapshotProgress({
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

function WorkspaceCard({
  workspace,
  vmName,
  onSnapshotStarted,
  onChange,
}: {
  workspace: VmWorkspace;
  vmName: string;
  onSnapshotStarted: (operation: RegistrationOperation) => void;
  onChange: () => void;
}) {
  const [confirm, setConfirm] = useState<'preserve' | 'discard' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [launchRequest] = useState(newRequestId);
  const [preserveRequest] = useState(newRequestId);
  const ready = workspace.state === 'ready';

  const relaunch = async () => {
    setBusy(true);
    setError(null);
    try {
      await launchWorkspace(workspace.id, launchRequest);
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card mb-2">
      <div className="card-body py-2 small">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <strong>{workspace.agentName}</strong>
          <span
            className={`badge ${ready ? 'text-bg-success' : workspace.state === 'preparing' || workspace.state === 'discarding' ? 'text-bg-info' : 'text-bg-secondary'}`}
          >
            {WORKSPACE_STATE_TEXT[workspace.state]}
          </span>
          {workspace.mayHaveChanges && ready ? (
            <span className="badge text-bg-warning">May have unpreserved changes</span>
          ) : null}
          {!workspace.agentOnline ? (
            <span className="badge text-bg-light border">Offline</span>
          ) : null}
        </div>
        <div className="mt-1">
          A working copy of{' '}
          <span className="vm-identity">{shortId(workspace.sourceVersionId)}</span>
          {workspace.baseVersionId !== workspace.sourceVersionId ? (
            <>
              , first restored from{' '}
              <span className="vm-identity">{shortId(workspace.baseVersionId)}</span>
            </>
          ) : null}
          . Created {formatTime(workspace.createdAt)}. It is separate from the persistent local
          copy.
        </div>
        {workspace.error ? <div className="text-danger mt-1">{workspace.error.message}</div> : null}
        <FormError error={error} />
        {ready ? (
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy || !workspace.agentOnline}
              onClick={() => void relaunch()}
            >
              Launch again
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={!workspace.agentOnline}
              onClick={() => setConfirm('preserve')}
            >
              Preserve as snapshot…
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={() => setConfirm('discard')}
            >
              Discard…
            </button>
          </div>
        ) : null}
        {ready ? (
          <p className="text-body-secondary mt-2 mb-0">
            Stop a running session from the Run section first: a running VM cannot be preserved or
            discarded.
          </p>
        ) : null}
      </div>
      {confirm === 'preserve' ? (
        <ConfirmDialog
          title="Preserve as a new snapshot"
          action="Create snapshot"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const operation = await preserveWorkspace(workspace.id, preserveRequest);
            setConfirm(null);
            onSnapshotStarted(operation);
            onChange();
          }}
        >
          The agent archives this working copy as a new, immutable snapshot whose parent is{' '}
          <span className="vm-identity">{shortId(workspace.sourceVersionId)}</span>, verifies it in
          the repository, and only then records it. No existing version is changed. The VM must not
          be running.
        </ConfirmDialog>
      ) : null}
      {confirm === 'discard' ? (
        <ConfirmDialog
          title="Discard this working copy"
          action="Discard"
          danger
          confirmName={workspace.mayHaveChanges ? vmName : undefined}
          onClose={() => setConfirm(null)}
          onConfirm={async (typed) => {
            await discardWorkspace(workspace.id, typed);
            setConfirm(null);
            onChange();
          }}
        >
          The agent deletes this working copy from its computer.{' '}
          {workspace.mayHaveChanges
            ? 'It may hold changes that are not in any snapshot, and they will be lost.'
            : 'Everything in it is already in a snapshot.'}{' '}
          Versions, and the persistent local copy, are not affected.
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

export function VmVersionHistory({ vm }: { vm: VmIdentity }) {
  const { emulatorType, vmName } = vm;
  const identity = { emulatorType, vmName };
  const loadTree = useCallback(
    (signal: AbortSignal) => fetchVersionTree({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadWorkspaces = useCallback(
    (signal: AbortSignal) => fetchWorkspaces({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadOptions = useCallback(
    (signal: AbortSignal) => fetchRestoreOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const [fastPoll, setFastPoll] = useState(false);
  const interval = fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  const tree = usePolledData(loadTree, interval);
  const workspaces = usePolledData(loadWorkspaces, interval);
  const options = usePolledData(loadOptions, interval);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [remote, setRemote] = useState<VersionNode | null>(null);
  const [snapshotting, setSnapshotting] = useState<{
    node: VersionNode;
    agentId: string;
    agentName: string;
    requestId: string;
  } | null>(null);
  const [snapshotOperation, setSnapshotOperation] = useState<string | null>(null);

  const workspaceList = workspaces.data?.workspaces ?? [];
  const busy =
    snapshotOperation !== null ||
    workspaceList.some((item) => item.state === 'preparing' || item.state === 'discarding');
  if (busy !== fastPoll) setFastPoll(busy);

  const refresh = () => {
    tree.refresh();
    workspaces.refresh();
    options.refresh();
  };

  if (tree.error && !tree.data) {
    return (
      <p className="small text-body-secondary">The version history is not available right now.</p>
    );
  }
  if (!tree.data) return <p className="small text-body-secondary">Loading the version history…</p>;

  const built = buildVersionTree(tree.data.versions);
  const activeWorkspaces = workspaceList.filter((item) =>
    ['preparing', 'ready', 'discarding'].includes(item.state),
  );
  const recentEnded = workspaceList
    .filter((item) => ['failed', 'lost'].includes(item.state))
    .slice(0, 3);

  return (
    <div className="version-history">
      {snapshotOperation ? (
        <SnapshotProgress
          key={snapshotOperation}
          operationId={snapshotOperation}
          onFinished={refresh}
        />
      ) : null}
      {!built.ok ? (
        <div className="alert alert-danger small" role="alert">
          The version history is inconsistent ({built.problem.replaceAll('_', ' ')}), so it is not
          drawn. No version has been changed.
        </div>
      ) : built.root === null ? (
        <p className="small">This VM has no versions yet.</p>
      ) : (
        <>
          <p className="small text-body-secondary">
            {built.count === 1 ? 'One version' : `${built.count} versions`}. Every version is a
            full, immutable archive; a snapshot records the version it was made from, so history can
            branch.
          </p>
          <ul role="tree" aria-label={`Versions of ${vmName}`} className="version-tree">
            <VersionItem
              entry={built.root}
              vm={identity}
              restoreOptions={options.data}
              onRestore={setRestoring}
              onSnapshot={(node, agentId, agentName) =>
                setSnapshotting({ node, agentId, agentName, requestId: newRequestId() })
              }
              onRemote={setRemote}
            />
          </ul>
        </>
      )}

      <h3 className="h6 mt-4">Remote Snapshot working copies</h3>
      {activeWorkspaces.length === 0 && recentEnded.length === 0 ? (
        <p className="small text-body-secondary">
          None. Launch a version in Remote Snapshot to run it without touching any local copy.
        </p>
      ) : (
        <ul className="list-unstyled">
          {[...activeWorkspaces, ...recentEnded].map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              vmName={vmName}
              onSnapshotStarted={(operation) => setSnapshotOperation(operation.id)}
              onChange={refresh}
            />
          ))}
        </ul>
      )}

      {restoring && options.data ? (
        <RestoreDialog
          vm={identity}
          options={options.data}
          initialVersionId={restoring}
          onClose={() => setRestoring(null)}
          onStarted={() => {
            setRestoring(null);
            refresh();
          }}
        />
      ) : null}
      {remote ? (
        <RemoteSnapshotDialog
          vm={identity}
          node={remote}
          options={options.data}
          onClose={() => setRemote(null)}
          onStarted={() => {
            setRemote(null);
            refresh();
          }}
        />
      ) : null}
      {snapshotting ? (
        <ConfirmDialog
          title={`Create a snapshot from ${snapshotting.agentName}`}
          action="Create snapshot"
          onClose={() => setSnapshotting(null)}
          onConfirm={async () => {
            const operation = await createSnapshot(identity, {
              agentId: snapshotting.agentId,
              parentVersionId: snapshotting.node.id,
              requestId: snapshotting.requestId,
            });
            setSnapshotting(null);
            setSnapshotOperation(operation.id);
            refresh();
          }}
        >
          <p>
            The agent archives its local copy of {vmName} as a new, immutable snapshot whose parent
            is <strong>{versionLabel(snapshotting.node)}</strong>, the version that copy came from.
            The archive is uploaded and verified in the repository before anything is recorded, and
            no existing version is changed. The local copy is read, never removed.
          </p>
          <p className="mb-0">The VM must not be running on that agent.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The version history as a section of the VM's administration page. */
export function VmVersionsSection({ vm }: { vm: VmIdentity }) {
  return (
    <section className="card" aria-labelledby="vm-versions-heading">
      <div className="card-body">
        <h2 id="vm-versions-heading" className="h6 card-title">
          Version history
        </h2>
        <VmVersionHistory vm={vm} />
      </div>
    </section>
  );
}
